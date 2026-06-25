# Agent Loop & Context 全链路优化方案

> 基于 2026-06-25 trace 数据分析 + 全量代码审计。覆盖 11 个核心模块，~9400 行代码。

## 目录

1. [当前性能基线](#一当前性能基线)
2. [Context Building 优化](#二context-building-优化)
3. [Intent Routing 优化](#三intent-routing-优化)
4. [Tool Decision & Execution 优化](#四tool-decision--execution-优化)
5. [Response Composition 优化](#五response-composition-优化)
6. [Loop Engine 优化](#六loop-engine-优化)
7. [Memory & Summary 优化](#七memory--summary-优化)
8. [优先级排序 & 实施路线](#八优先级排序--实施路线)

---

## 一、当前性能基线

### 1.1 典型请求 trace（"你好" + 52条历史）

```
context_building       28ms   2.8k tokens
  ├── context_group_a   4ms   6路并行IO（消息/记忆/嵌入/制品/工具/技能）
  └── memory_search     4ms   hybrid + vector recall

pre_inference_await  undefined  待修复

intent_routing        1.3s    走 Layer 2 LLM
  └── intent_route     1.3s   完整 LLM 调用

tool_deciding          13ms   确定性评分器，返回 no_tool

response_composition  11.9s   3.5k input, 56 output
```

### 1.2 Token 消耗分解

```
ContextBuilder 产出 (2.8k):
├── 52 条历史消息               ~2,000 (71%)  ← 主因
├── Skill catalog               ~400  (14%)
├── System prompt (persona/rules/safety) ~200 (7%)
├── Current message + run state ~100  (4%)
└── 其他                        ~100  (4%)

ResponseComposer 叠加 (+0.7k → 3.5k):
├── Skill catalog (重复发送)    ~400
├── MARKDOWN_RESPONSE_POLICY    ~125
└── System prompt 格式化        ~175
```

---

## 二、Context Building 优化

**模块**: `context-builder.ts` (1329行), `context-budgeter.ts` (112行), `memory-compressor.ts` (246行)

**当前流程**:

```
1. System chunks 构建             <1ms
2. Parallel IO Group A (6路)      4-8ms
3. Summary stale detection        <1ms
4. History chunk 逐条构建         <1ms
5. Memory search (Group B)        4-7ms
6. Per-source compression         <1ms
7. Token budget apply             <1ms
```

### 2.1 对话历史滑动窗口截断

**问题**: 无论消息多旧，每条保留全文。52 条历史全量入 context。

**文件**: `context-builder.ts:627-648`

**方案**: 在构建 `conversation_history` chunk 时按消息年龄分层截断。

```typescript
const RECENT_FULL = 10;         // 最近 10 条保留全文
const SEMI_RECENT_MAX = 500;    // 11-20 条每条 ≤500 字符
const OLDER_MAX = 150;          // 更早的消息每条 ≤150 字符（首句）

for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const age = messages.length - 1 - i; // 0=最新

    let content = msg.content;
    if (age >= 20 && content.length > OLDER_MAX) {
        content = extractFirstSentence(content, OLDER_MAX);
    } else if (age >= 10 && content.length > SEMI_RECENT_MAX) {
        content = content.slice(0, SEMI_RECENT_MAX) + '…';
    }
    // age < 10: 保留全文

    chunks.push({ content, ... });
}
```

**效果**: 52条历史从 ~2000 tokens → ~800 tokens。

**注意**: 摘要（`conversation_summary`）存在时优先级更高——被摘要覆盖的消息直接跳过，不进入截断逻辑。

### 2.2 Skill catalog 按意图过滤

**问题**: skill catalog 始终全量发送（所有已注册 skill 的 name + id + description），与当前 intent 无关。

**文件**: `context-builder.ts:976-1028`

**方案**: 根据 intent 类型动态决定是否发送以及发送多少。

```typescript
const SKIP_SKILL_FOR_INTENT = new Set([
    'casual_chat',      // 聊天不需要工具
    'question_answering', // 直接回答不需要
]);

if (!SKIP_SKILL_FOR_INTENT.has(intent.type)) {
    // 按 intent 过滤相关 category 的技能
    const relevant = filterSkillsByIntent(skills, intent);
    // 最多保留 10 个（当前是全量）
    const topSkills = relevant.slice(0, 10);
    // 构建 chunk...
}
```

**效果**: casual_chat / question_answering 场景省 ~400 tokens。

### 2.3 Memory search 按 intent 跳过

**问题**: casual_chat 不需要记忆，但仍执行完整的 memory search pipeline（hybrid + vector + multi-hop + re-rank）。

**文件**: `context-builder.ts:662-924`

**方案**: 在 memory search 之前检查 intent（需要先有 intent，但 context building 和 intent routing 是串行的；可以用 pre-inference 的 intentType 做早期决策）。

```typescript
// 替代方案：根据 conversation 长度判断
const SKIP_MEMORY_FOR_SHORT_CONVO = 5; // ≤5 条消息的新对话不需要记忆

if (messages.length <= SKIP_MEMORY_FOR_SHORT_CONVO) {
    // 跳过 Group B memory search
    // 省 4-7ms + embedding API 调用
}
```

### 2.4 TokenBudgeter 分级压缩替代丢弃

**问题**: `TokenBudgeter.apply()` 对超预算的 chunk 直接丢弃（`excluded`）。对于 `conversation_history`，应该压缩而非丢弃。

**文件**: `context-budgeter.ts:84-92`

**方案**: 在 `apply()` 中增加一个预压缩 pass。在按优先级排序后、分配预算前，对低优先级 chunk 做压缩。

```typescript
// 预压缩：对 conversation_history 类型的 chunk
for (const chunk of sorted) {
    if (chunk.source === 'conversation_history' && chunk.content.length > 300) {
        // 压缩到 300 字符（首句 + 关键词）
        chunk.content = compressHistoryMessage(chunk.content, 300);
        chunk.tokenEstimate = estimateTokens(chunk.content);
    }
}
```

### 2.5 Per-source compression 阈值调整

**问题**: 当前的 `MAX_TOOL_RESULT_CHARS=2000`、`MAX_MEMORY_CHARS=800` 等阈值是硬编码的，没有根据实际 token budget 动态调整。

**文件**: `context-builder.ts:1064-1068`

**方案**: 用百分比替代绝对值。例如 `maxToolResultChars = min(2000, availableTokens * 0.05 * 4)`。

### 2.6 Summary stale detection 只跑一次

**问题**: `checkStale()` 对每个 summary memory 都调用一次。如果有多份摘要（按时间分段），会重复检测。

**文件**: `context-builder.ts:471-581`

**方案**: 对同一个 `conversationId` 的摘要合并检测，一次 `checkStale()` 覆盖所有摘要。

---

## 三、Intent Routing 优化

**模块**: `intent-router.ts` (606行), `agent-loop-engine.ts` pre-inference 部分

### 3.1 修复 unknown 置信度过高

**问题**: pre-inference 无法分类时返回 `unknown` at `0.7`，刚好 `>= 0.7` 通过阈值，导致跳过 Layer 2 LLM，用低质量分类继续执行。

**文件**: `agent-loop-engine.ts:523`

```diff
- else if (rawCategory === "unknown") intentConfidence = 0.7;
+ else if (rawCategory === "unknown") intentConfidence = 0.6; // < 0.7，触发 Layer 2 回退
```

### 3.2 Pre-inference 竞速而非等待

**问题**: 当前 `buildContextAndIntent` 内部 `await` pre-inference 的结果，context 完成后干等 pre-inference。两个 LLM 调用串行化。

**文件**: `agent-loop-engine.ts:260-296, 617-650`

**方案**: 不在 `buildContextAndIntent` 内部等待 pre-inference。恢复并行模式——context building 和 pre-inference 并行启动，intent routing 也同时启动。在 intent routing 的 Layer 0/1 完成时检查 pre-inference 是否已就绪：

- 如果 pre-inference 已就绪且置信度 ≥ 0.7 → 用 `routeWithPreInference` 跳过 Layer 2
- 如果 pre-inference 未就绪 → 继续走完整的 Layer 2 LLM

```typescript
// run() 中的新流程
const prePromise = runPreliminaryInference(input, signal);
const ctxPromise = buildContext(input, signal);  // 只构建 context，不含 intent routing
const ctx = await ctxPromise;                     // 28ms

// 并行：pre-inference 和 intent routing 同时跑
const routePromise = intentRouter.route(ctx, signal);  // Layer 0→1→2
const preResult = await racePreliminaryWithTimeout(prePromise, 1500);

if (preResult?.intentType) {
    // pre-inference 已完成，可以 abort 掉还在跑的 route
    // 但如果 route 已经过了 Layer 1，直接用 route 结果
}
// 如果 pre 比 route 快，route 可能还在跑 Layer 2
// 此时用 pre 的结果调用 routeWithPreInference 会瞬间返回
```

**效果**: pre-inference 不增加延迟，pre-inference 和 Layer 2 完全并行，总耗时 = min(pre, route)。

### 3.3 Pre-inference 分类覆盖扩充

**问题**: prompt 只覆盖 7 个分类（product_search, image_analysis, casual_chat, data_analysis, web_search, file_operation, unknown），缺少 diagnostics、automation_execution、artifact_generation 等。

**文件**: `agent-loop-engine.ts:468-482, 506-517`

**方案**:

```diff
  Output format:
- {"intentCategory": "product_search"|"image_analysis"|"casual_chat"|"data_analysis"|"web_search"|"file_operation"|"unknown", ...}
+ {"intentCategory": "product_search"|"image_analysis"|"casual_chat"|"data_analysis"|"web_search"|"file_operation"|"diagnostics"|"automation"|"artifact_generation"|"unknown", ...}

  // mapping 里补全
  const intentTypeMap = {
      ...
+     "diagnostics": "diagnostics",
+     "automation": "automation_execution",
+     "artifact_generation": "artifact_generation",
  };
```

### 3.4 Layer 2 LLM prompt 瘦身

**问题**: `classifyWithLlm()` 的 prompt 包含**全部** skill catalog（name + id + description），即使有 20+ 个 skill 也一样。对 casual_chat 这种不需要工具的意图，全量 skill 列表是噪音。

**文件**: `intent-router.ts:318-342`

**方案**: 当 `embeddingHints` 提供 Top-5 候选时，只发送前 5 个 skill 而非全量。LLM 仍可以从全量 catalog 中选（通过在 prompt 中说 "or pick any other from the catalog below"），但默认只展示最相关的。

### 3.5 Pre-inference trace 修复

**问题**: `pre_inference_await` span 显示 `undefinedms`，因为 metrics 缺少 `latencyMs`。

**文件**: `agent-loop-engine.ts:440-448, 456-459, 631-638, 641-646`

**方案**: 确保所有 `endSpan` 调用都包含 `latencyMs`。已在上一轮修复。

### 3.6 Layer 1 embedding 阈值可配置

**问题**: 短路径阈值 hardcode 0.95，无法根据实际部署的 embedding 模型质量调整。

**文件**: `intent-router.ts:96` (constructor), `intent-router.ts:219` (matchSkillWithEmbedding)

**方案**: 已实现 `embeddingShortCircuitThreshold` 参数 + `SUNPILOT_INTENT_EMBEDDING_THRESHOLD` 环境变量。

### 3.7 Embedding 批处理中 skill 数量

**问题**: `matchSkillWithEmbedding` 对所有 skill 逐一嵌入（batch 8）。如果 embedding API RTT 是 50ms，20 个 skill 需要 `ceil(20/8) * 50ms = 150ms`。

**文件**: `intent-router.ts:188-205`

**方案**: Skill embedding cache 预热后这不再是问题。但首次冷启动时可以增大 batch size 或使用 `embedBatch` API。

---

## 四、Tool Decision & Execution 优化

**模块**: `tool-decision-engine.ts` (2841行), `tool-retriever.ts` (438行)

### 4.1 多工具并行执行

**问题**: `executeToolCalls()` 用 `for...of` 串行执行所有 tool call。LLM 一次返回 3 个 tool call 时，总耗时 = sum(3个latency)。

**文件**: `tool-decision-engine.ts:1793`

**方案**:

```typescript
// 当前（串行）
for (const tc of toolCalls) {
    const observation = await this.deps.executionOrchestrator.execute(...);
}

// 优化（并行）
const execResults = await Promise.allSettled(
    toolCalls.map(tc => this.deps.executionOrchestrator.execute(...))
);
// 保持原始顺序处理结果
for (let i = 0; i < toolCalls.length; i++) {
    const r = execResults[i];
    if (r.status === 'fulfilled') { /* emit tool results */ }
    else { /* emit error */ }
}
```

**效果**: 多工具场景延迟从 sum → max。3 个各 2s 的工具：6s → 2s。

**风险**: 工具间如果有隐式依赖（tool B 需要 tool A 的输出），需要保留串行逻辑。可以通过 `PlannedToolCall.dependsOn` 或 `argumentSources` 判断。

### 4.2 意图过滤工具目录

**问题**: 首轮 LLM 永远发送 20 个 tool definition。对于明确意图，多余工具浪费 tokens + 增加 LLM 选错工具的风险。

**文件**: `tool-decision-engine.ts:1576`

**方案**: 根据 intent.type 和 `candidateSkills` 动态缩减。

```typescript
const TOPK_BY_INTENT: Partial<Record<string, number>> = {
    casual_chat: 0,
    image_analysis: 5,
    product_search: 5,
    file_operation: 3,
    question_answering: 0,
    default: 15,
};

const limit = TOPK_BY_INTENT[intent.type] ?? TOPK_BY_INTENT.default;

// 候选技能排最前
const candidates = new Set(intent.candidateSkills);
const sorted = [...retrieval.tools].sort((a, b) => {
    const aIsCandidate = candidates.has(a.skill.id) ? 0 : 1;
    const bIsCandidate = candidates.has(b.skill.id) ? 0 : 1;
    return aIsCandidate - bIsCandidate || b.score - a.score;
});

const topTools = sorted.slice(0, limit);
```

### 4.3 LLM 第一轮 prompt 瘦身

**问题**: `buildStreamingMessages()` 的 system prompt 包含大量指令（persona + rules + safety + plan + prioritySkills），即使 slim 模式也约 400-500 tokens。

**文件**: `tool-decision-engine.ts:1401-1465`

**方案**:

1. **分离稳定 prompt 和动态 prompt**: persona/rules/safety 每次相同，可以用 LLM API 的 `system` 参数（会被缓存）。动态部分（plan, prioritySkills）放 user message。
2. **MARKDOWN_RESPONSE_POLICY 移到最终回答轮**: 第一轮工具调用不需要格式化指令。

### 4.4 ToolRetriever embedding 层批处理优化

**问题**: `ToolRetriever.retrieve()` 中 embedding 计算和 `IntentRouter.matchSkillWithEmbedding()` 做了**完全相同的事**：嵌入 query + 嵌入所有 skill → 计算相似度。两个模块各自独立计算。

**文件**: `tool-retriever.ts:237-287`, `intent-router.ts:164-269`

**方案**: ToolRetriever 复用 IntentRouter 的 embedding 结果。IntentRouter 把 `queryEmbedding` 和 `skillEmbeddings` 存在 context 或共享缓存里。

### 4.5 Tool result projection 对长内容截断

**问题**: `projectToolResultForModel()` 当 `modelObservation` 超过 8000 字符时截断。但对于搜索结果（可能返回 100+ 条），8000 字符仍然很多——第二轮 LLM 要处理的 context 膨胀。

**文件**: `tool-decision-engine.ts:2297-2335`

**方案**: 按模型窗口大小动态调整截断阈值：

```typescript
const MAX_OBSERVATION_CHARS = Math.min(8000, maxContextTokens * 2);
```

### 4.6 工具调用签名去重优化

**问题**: 去重用 `skillId:JSON.stringify(args)` 做 key。args 对象键顺序不稳定时可能产生不同的签名，漏过去重。

**文件**: `tool-decision-engine.ts:1137-1150`

**方案**: 用稳定序列化（`JSON.stringify(args, Object.keys(args).sort())`）保证相同参数产生相同签名。

### 4.7 deterministic scorer 权重调整

**问题**: `scoreSkills()` 中 bigram 权重已从 0.8/0.6 降到 0.15/0.1，但描述关键词权重（0.2/0.1）在中文场景下容易误匹配。

**文件**: `tool-decision-engine.ts:2574-2635`

**方案**: 将描述匹配的权重降一半（0.2→0.1, 0.1→0.05），让 embedding（权重 0.5）成为主导信号。

---

## 五、Response Composition 优化

**模块**: `response-composer.ts` (349行), `markdown-response-policy.ts` (~500 chars)

### 5.1 no_tool 路径不发 skill catalog

**问题**: `buildMessages()` 无条件把全部 skill 列表塞进 system prompt。

**文件**: `response-composer.ts:267-275`

**方案**:

```typescript
// 只在需要工具时发送
if (context.availableSkills.length > 0 && intent.requiresTool) {
    // 只发 intent 相关的 skills，而非全量
    const relevantSkills = filterByIntent(context.availableSkills, intent);
    const skillLines = relevantSkills.map(s => `- ${s.name} (${s.id}): ${s.description}`);
    messages.push({ role: "system", content: "Available tools:\n" + skillLines.join("\n") });
}
```

**效果**: casual_chat 省 ~400 tokens。

### 5.2 MARKDOWN_RESPONSE_POLICY 条件加载

**问题**: 每条消息都加载完整的 markdown 格式化策略（~125 tokens），即使"你好"不需要。

**文件**: `response-composer.ts:235`

**方案**: 只在非 trivial 响应时加载。例如 `intent.type !== 'casual_chat'` 时才加。

### 5.3 ContextSnapshot 透传瘦身

**问题**: `streamAndSave()` 把整个 `contextSnapshot`（包含所有 chunk 的 metadata）作为 metadata 传给 LLM provider，增加不必要的 payload。

**文件**: `response-composer.ts:112, 142`

**方案**: LLM 不需要 contextSnapshot（这是给 observability 用的）。从 LLM 请求 metadata 中移除，只保留在持久化时。

### 5.4 系统 prompt 去重

**问题**: `context.system.persona` 在 `ContextBuilder` 里作为 chunk 发了一次，在 `ResponseComposer.buildMessages()` 里又发了一次。如果 context.messages 里已经包含 system role 的 persona，ResponseComposer 不需要再发。

**文件**: `response-composer.ts:234`

**方案**: 检查 `context.messages` 里是否已经有 system role 的消息，如果有则跳过 persona 的重复发送。

---

## 六、Loop Engine 优化

**模块**: `agent-loop-engine.ts` (2167行)

### 6.1 Pre-inference 不在 buildContextAndIntent 内部等待

见 [3.2](#32-pre-inference-竞速而非等待)。

### 6.2 MAX_TOOL_ITERATIONS 动态化

**问题**: 硬上限 5 轮。简单任务 1 轮就够，复杂任务 5 轮不够。

**文件**: `agent-loop-engine.ts:53`

**方案**:

```typescript
// 改为基于 intent 和 plan 的动态上限
function computeMaxIterations(intent: RoutedIntent, plan?: AgentPlan): number {
    if (plan && plan.steps.length > 0) {
        return Math.max(5, plan.steps.length + 2); // plan steps + buffer
    }
    if (intent.type === 'project_analysis') return 8;
    if (intent.type === 'automation_execution') return 10;
    return 5; // default
}
```

### 6.3 Plan 驱动的迭代验证

**问题**: 当有 plan 时，loop 应该在每轮结束后检查 plan 的完成度，而非仅依赖 LLM 自主停止。

**文件**: `agent-loop-engine.ts:741-953` (runContentBlockLoop)

**方案**: 在每轮工具执行后，检查 plan steps 的完成状态。如果所有 tool 类型的 step 都 completed，即使 LLM 想继续，也注入提示引导 LLM 总结。

### 6.4 Abort 信号传递优化

**问题**: `signal.aborted` 在多个地方检查（while 循环开头、LLM 调用后、工具执行后），但工具执行过程中没有主动 abort 已启动的异步操作。

**文件**: `tool-decision-engine.ts:1058, 1770-2220`

**方案**: 并行执行时，将 `signal` 传递给每个子任务。当 signal aborted 时，`Promise.allSettled` 中的未完成项自动拒绝。

### 6.5 Event emit 性能

**问题**: 每轮 loop 大量 emit event（`agent.model.started`, `agent.model.delta`, `agent.tool.selected`, `agent.tool.started`, `agent.tool.completed`...），高频 delta emit 在 WebSocket 场景下可能成为瓶颈。

**文件**: `agent-loop-engine.ts` 全文散布

**方案**: 
1. `agent.model.delta` 做 throttling（每 50ms 最多 emit 一次）
2. 非用户可见的 event 不用 WebSocket 广播（只记录 trace）

### 6.6 Stream complete 后的二次 await

**问题**: `run()` 中 `preliminaryPromise` 在 `buildContextAndIntent` 内部已 await 过一次，`run()` 中又 `racePreliminaryWithTimeout(preliminaryPromise, 1500)` 一次。已 resolved 的 promise 虽然瞬间返回，但多余代码增加维护负担。

**文件**: `agent-loop-engine.ts:295-297`

**方案**: 只在一个地方 await。如果 `buildContextAndIntent` 不再需要 pre-inference（改为竞速后），只在 `run()` 中获取结果用于 tool hints。

---

## 七、Memory & Summary 优化

**模块**: `memory-writer.ts` (601行), `memory-compressor.ts` (246行), `summary-stale-detector.ts` (228行)

### 7.1 摘要生成触发条件修复（最关键）

**问题**: 3 个触发条件都不适用于纯聊天长对话：

```
goalAchieved:         需要工具调用完成 ← "你好" 没有
forceSummary:         tokenRatio > 0.4  ← 2.8k/128k = 0.02
shouldRollingSummarize: messages ≥ 20 AND tool_turns > 0 ← "你好" 没工具
```

**文件**: `memory-writer.ts:227-240`

**方案**:

```typescript
// 新增纯消息数量触发
const shouldSummarizeByMessageCount =
    input.context.messages.length >= 30 &&
    !input.observation;  // 纯聊天，无工具调用

const shouldSummarize =
    (input.observation &&
     (input.reflection?.goalAchieved ||
      input.forceSummary ||
      shouldRollingSummarize)) ||
    shouldSummarizeByMessageCount;  // ← 新增
```

### 7.2 摘要内容粒度优化

**问题**: 当前摘要格式把所有 `toolCalls` 拼成文本（`memory-writer.ts:244-249`），但纯聊天没有 toolCalls，摘要变成空壳。

**文件**: `memory-writer.ts:241-310`

**方案**: 区分"有工具"和"无工具"两种摘要格式：

```
有工具: 目标 + 决策 + 工具结果摘要 + 用户偏好
无工具: 讨论主题 + 关键结论 + 用户偏好 + 未解决问题
```

### 7.3 摘要生成时机前移

**问题**: 摘要在 `writeMemories()` 中生成，发生在 response 返回给用户**之后**。用户下一次发消息时才受益。

**文件**: `agent-loop-engine.ts:957-979`

**方案**: 在 context building 阶段检测消息数量，如果已超过阈值，**先**生成摘要**再**构建 context。这样当前请求就受益。

```typescript
// context-builder.ts 中新增
if (messages.length >= 30 && summaryMemoriesResult.length === 0) {
    // 需要摘要但还没有 → 同步生成一份
    const summary = await generateConversationSummary(messages);
    // 用摘要替代旧消息
}
```

### 7.4 MemoryCompressor LLM summarization

**问题**: `MemoryCompressor` 支持 LLM 摘要回调（`summarize`），但 `ContextBuilder` 构造时没传这个回调，用的是纯文本截断。

**文件**: `context-builder.ts:1068` 构造 `MemoryCompressor` 时

**方案**: 传入 LLM `summarize` 回调。对高价值记忆（user_preference、project_profile）用 LLM 摘要替代截断。

### 7.5 Summary stale detection 对纯聊天扩展

**问题**: `SummaryStaleDetector` 的 4 个检测维度中，"Fact change" 依赖 `newToolResults`。纯聊天场景没有工具结果，检测不到潜在的话题漂移。

**文件**: `summary-stale-detector.ts:97-109`

**方案**: 增加 "topic drift" 检测——比较新消息和摘要内容的关键词重叠度。如果重叠度 < 30%，认为话题已转移，摘要可能过时。

### 7.6 记忆写入去重

**问题**: `writeFromTurn()` 每次 turn 后都写入记忆。连续 5 轮工具调用的同一个 run，会写入 5 次相似的工具观察记忆。

**文件**: `memory-writer.ts`

**方案**: 写记忆前检查是否已有相同 `(scope, scopeId, type)` 的记录且置信度相近（±0.1），跳过重复写入。

---

## 八、优先级排序 & 实施路线

### 阶段一：P0（1-2 行改动，立刻生效）

| # | 优化项 | 文件 | 行数 | 效果 |
|---|--------|------|------|------|
| 1 | 摘要触发加消息数量条件 | `memory-writer.ts` | +3 | 长对话自动压缩，历史从 52 条→摘要+最近N条 |
| 2 | no_tool 不发 skill catalog | `response-composer.ts` | +3 | "你好"省 ~400 tokens |
| 3 | unknown 置信度 0.7→0.6 | `agent-loop-engine.ts` | 1 | 防止错误跳过 Layer 2 |
| 4 | 摘要生成时机前移 | `context-builder.ts` | +15 | 首次超阈值请求就受益 |
| 5 | ResponseComposer 不发重复 persona | `response-composer.ts` | +5 | 省 ~50 tokens/请求 |

### 阶段二：P1（中等改动，显著收益）

| # | 优化项 | 文件 | 行数 | 效果 |
|---|--------|------|------|------|
| 6 | 对话历史滑动窗口截断 | `context-builder.ts` | +30 | 即时生效的 token 压缩 |
| 7 | 多工具并行执行 | `tool-decision-engine.ts` | +30 | 多工具延迟 sum→max |
| 8 | 意图过滤工具目录 | `tool-decision-engine.ts` | +20 | 首轮 LLM 更快 + 更准 |
| 9 | Skill catalog 按意图过滤 | `context-builder.ts` | +15 | casual_chat 省 ~400 tokens |
| 10 | Pre-inference 竞速重构 | `agent-loop-engine.ts` | +40 | pre-inference 不增加延迟 |
| 11 | MARKDOWN_RESPONSE_POLICY 条件加载 | `response-composer.ts` | +3 | trivial 响应省 ~125 tokens |
| 12 | ToolDef 首轮 limit 调小 | `tool-decision-engine.ts` | +10 | prompt 瘦身 |

### 阶段三：P2（深度优化）

| # | 优化项 | 文件 | 行数 | 效果 |
|---|--------|------|------|------|
| 13 | Pre-inference 分类覆盖扩充 | `agent-loop-engine.ts` | +10 | 更多查询跳过 Layer 2 |
| 14 | ToolRetriever 复用 IntentRouter embedding | 2 文件 | +20 | 省一次 embedding API 调用 |
| 15 | 摘要内容区分有/无工具模式 | `memory-writer.ts` | +20 | 纯聊天摘要更有用 |
| 16 | Memory 按消息数量跳过检索 | `context-builder.ts` | +5 | ≤5 条消息的新对话省 7ms |
| 17 | ContextSnapshot 不从 LLM payload 走 | `response-composer.ts` | 1 | 省 HTTP payload |
| 18 | TokenBudgeter 压缩替代丢弃 | `context-budgeter.ts` | +10 | 不丢上下文，只压缩 |
| 19 | deterministic scorer 权重微调 | `tool-decision-engine.ts` | 改数字 | 减少中文误匹配 |
| 20 | MAX_TOOL_ITERATIONS 动态化 | `agent-loop-engine.ts` | +15 | 复杂任务不截断 |

### 阶段四：P3（长期改进）

| # | 优化项 | 说明 |
|---|--------|------|
| 21 | model_delta event throttling | WebSocket 广播降频 |
| 22 | Memory 写入去重 | 同 run 内跳过重复 |
| 23 | Per-source compression 动态阈值 | 基于 token budget 百分比 |
| 24 | 工具签名去重稳定序列化 | sort keys before stringify |
| 25 | Plan 驱动的迭代验证 | 不用只靠 LLM 喊停 |

---

## 附录：关键文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `agent-loop-engine.ts` | 2167 | Loop 状态机 + pre-inference |
| `context-builder.ts` | 1329 | 上下文组装管线 |
| `context-budgeter.ts` | 112 | Token 预算裁剪 |
| `context-types.ts` | 91 | Chunk 类型定义 + 优先级常量 |
| `memory-compressor.ts` | 246 | 单条记忆压缩 |
| `summary-stale-detector.ts` | 228 | 摘要过时检测 |
| `intent-router.ts` | 606 | 4 层级联意图分类 |
| `tool-decision-engine.ts` | 2841 | 工具决策 + streaming 执行 |
| `tool-retriever.ts` | 438 | 多层工具检索管线 |
| `response-composer.ts` | 349 | 最终回复生成 |
| `memory-writer.ts` | 601 | 记忆/摘要写入 |
| `model-router.ts` | 492 | LLM 路由 + 调用追踪 |
| `composition-root.ts` | ~800 | 依赖注入组装 |

---

## 九、Digital World 优化方案

**模块**: `packages/web/src/features/digital-world/` (27 文件, ~2839 行)

**技术栈**: React 18 + PixiJS 8 (Canvas 2D) + Ant Design + Dijkstra 寻路

**架构总览**:

```
DigitalWorld.tsx (容器组件)
├── Canvas (PixiJS Application)
│   ├── WorldGrid          — 网格背景
│   ├── RoadLayer          — 道路连线
│   ├── WorkstationNode[]  — 6 类工作站节点 (纯 Graphics 矢量绘制)
│   ├── DigitalBeingEntity — 数字生命实体 (带 6 种动画状态)
│   ├── StatusBubbleLayer  — 状态气泡
│   └── CameraController   — 拖拽平移 + 滚轮缩放
├── UI Overlay (React)
│   ├── WorldFloatingDock  — 浮动工具栏
│   ├── TaskPanel          — 任务面板
│   ├── ArtifactBoxPanel   — 产物面板
│   ├── BeingChatPanel     — 对话面板
│   ├── StatusPanel        — 状态面板
│   └── ActionLogPanel     — 日志面板
├── Hooks
│   ├── useWorldApp        — PixiJS App 生命周期
│   ├── useBeingMovement   — 寻路 + 动画
│   └── useDigitalWorldBootstrap — 数据加载 + 5s 轮询
└── Pathfinding
    ├── graph.ts           — 图构建
    ├── dijkstra.ts        — 最短路径
    └── route-animation.ts — 路径动画
```

### 9.1 当前状态

| 维度 | 现状 |
|------|------|
| 渲染引擎 | PixiJS 8, Canvas 2D, 无 WebGL 优化 |
| 建模方式 | 纯 Graphics 矢量绘制 (Graphics API, 无纹理/精灵) |
| 动画 | Shared Ticker callback, sin/cos 基础数学 |
| 布局 | 6 个节点十字路口 mock 布局 |
| 数据 | API 优先, DEV fallback mock, 5s 轮询 |
| 交互 | 点击节点→面板, 点击 Being→状态, 拖拽平移, 滚轮缩放 |
| 状态 | 7 种 Being 状态, 6 种动画 (idle/moving/working/...) |
| 寻路 | Dijkstra 最短路径 + 线性插值动画 |

---

### 9.2 核心优化

#### 9.2.1 PixiJS 渲染管线升级 (WebGL → 减少 CPU 绑定)

**问题**: 当前用 `new Graphics()` 每次 `drawWorld()` 都重新构建所有图形对象。节点重建时逐条 `fill()` / `stroke()` 调用是 CPU 密集操作。

**文件**: `WorldApp.ts:299-330` (drawWorld), `WorkstationNode.ts` (所有 draw 函数)

**方案**:

1. **静态对象用 `Graphics.context` API** — PixiJS 8 的 `Graphics.context` 支持批量绘制命令，减少 draw call。
2. **不变图形缓存为 Texture** — 将 6 种工作站 icon 预渲染为 `Texture`，绑定到 `Sprite` 上，避免每帧重建。
3. **脏标记增量更新** — `setData()` 中加 dirty flag，只在 nodes/edges 变化时重绘，其余只更新 being 位置。

```typescript
// 预渲染 icon 纹理（一次性）
const iconTextures = new Map<string, Texture>();
for (const [type, drawer] of Object.entries(ICON_DRAWERS)) {
    const g = new Graphics();
    drawer(g, accent, 0, 0, iconSize);
    iconTextures.set(type, app.renderer.generateTexture(g));
    g.destroy();
}
// WorkstationNode 中用 Sprite 替代 Graphics
```

#### 9.2.2 Ticker 实例管理

**问题**: `DigitalBeingEntity` 使用 `Ticker.shared` 注册动画回调。Shared ticker 在组件 unmount 或 app destroy 时可能导致回调泄漏。

**文件**: `DigitalBeingEntity.ts:133,152,175,201`, `WorldApp.ts:234`

**方案**: 改用 App 专属 ticker (`this.app.ticker`) 替代 `Ticker.shared`，destroy 时自动清理所有回调。

#### 9.2.3 轮询优化 — 增量更新 + 自适应频率

**问题**: `useWorldStatePolling` 固定 5s 轮询全量世界状态。用户不操作时也在轮询，浪费网络。

**文件**: `useDigitalWorldBootstrap.ts:121-145`

**方案**:

1. **可见性检测** — tab 不可见时暂停轮询，切回时立即拉一次。
2. **自适应轮询频率** — being 在 `working` 状态时提高频率 (2s)，`idle`/`sleeping` 时降低 (15s)。
3. **事件驱动替代轮询** — 后端推送 WebSocket 事件 `world.state.changed`，前端收到后拉取增量。

```typescript
useEffect(() => {
    const handleVisibility = () => {
        if (document.hidden) clearInterval(interval);
        else fetchWorldState(); // 立即刷新
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
}, []);
```

#### 9.2.4 Canvas resize 防抖

**问题**: `WorldApp.resize()` 在窗口 resize 时重新渲染整个网格，高频 resize（拖动窗口边缘）时浪费性能。

**文件**: `WorldApp.ts:157-161` (resize), `useWorldApp.ts`

**方案**: 加 200ms debounce，避免中间态渲染。

#### 9.2.5 节点交互事件委托

**问题**: `setupNodeInteraction()` 给每个节点单独绑定 `pointerover/pointerout/pointerdown/pointerup` 4 个事件。10 个节点 = 40 个事件监听器。

**文件**: `WorldApp.ts:246-283`

**方案**: 使用 PixiJS 的 `EventSystem` 事件冒泡 — 在 viewport container 上统一监听，通过 `event.target.label` 判断点击的节点。

#### 9.2.6 寻路缓存

**问题**: 每次 `triggerMoveTo()` 都重新 `buildGraph()` + `findShortestPath()`。graph 只有在 nodes/edges 变化时才需要重建。

**文件**: `useBeingMovement.ts:20-64`

**方案**: 缓存 graph 对象，仅在 `world.nodes` 或 `world.edges` 引用变化时重建。

```typescript
const graphRef = useRef<ReturnType<typeof buildGraph> | null>(null);
// 在 triggerMoveTo 中：
if (!graphRef.current || nodesChanged) {
    graphRef.current = buildGraph(world.nodes, world.edges);
}
```

---

### 9.3 建模美化

#### 9.3.1 数字生命实体升级

**当前**: 纯矩形+圆形拼接（履带 + 方形身体 + 方形头部 + 圆眼），类似 90 年代 RPG 风格。

**文件**: `DigitalBeingEntity.ts:1-228`

**方案**:

| 优化点 | 当前 | 改进 |
|--------|------|------|
| **身体比例** | 48×60 像素，方头方脑 | 调整为更可爱的 Q 版比例 (1:1.2 头身比) |
| **颜色方案** | 灰蓝色调 (#94a3b8, #334155) | 渐变着色 + 高光，区分不同状态 |
| **眼睛** | 两个实心圆 | 带瞳孔 + 眨眼动画 + 跟随鼠标方向 |
| **手臂** | 矩形，working 时微振 | 关节动画（上臂+前臂），working 时做打字/操作动作 |
| **履带** | 简单矩形 + 小轮子 | 履带纹理 + moving 时轮子旋转动画 |
| **阴影** | 固定椭圆 alpha=0.08 | 动态阴影（随位置和缩放变化） |

#### 9.3.2 工作站节点视觉升级

**当前**: 白色卡片 + 左侧彩色条纹 + 矢量 icon + 底部文字。6 种 icon 是纯 Graphics 手绘，较为简陋。

**文件**: `WorkstationNode.ts:1-302`

**方案**:

| 优化点 | 当前 | 改进 |
|--------|------|------|
| **卡片设计** | 白底 + 灰色边框 | 圆角卡片 + 微阴影 + 顶部渐变条 |
| **Icon** | 纯色矢量图 | 双色/三色渐变 + 发光效果 (glow) |
| **状态指示** | 右上绿色圆点 | 脉冲动画 + 状态颜色映射 (绿/黄/红/灰) |
| **Hover 效果** | scale(1.04) + alpha 0.85 | 上浮阴影 + 边框高亮 + 平滑过渡 |
| **字体** | 11px sans-serif | 12px 系统字体 + 更清晰的对比度 |
| **尺寸** | 固定 90-140px 宽 | 响应式缩放，小屏不拥挤 |

#### 9.3.3 环境美化

**文件**: `constants.ts`, `WorldGrid.ts`, `RoadLayer.ts`

**当前**: 纯白背景 + 浅灰网格 + 灰色道路，非常朴素。

**方案**:

| 元素 | 当前 | 改进 |
|------|------|------|
| **背景** | `0xffffff` 纯白 | 淡蓝渐变色 `0xf0f4ff` → `0xffffff`，或低多边形地形 |
| **网格** | 实线 `0xeef2f7` | 点状网格 (dotted) 或淡化到仅在缩放时可见 |
| **道路** | 灰色粗线 `0xd1d5db` 6px | 双线道路 + 虚线中线 + 路口圆角连接 |
| **装饰** | 无 | 草地/树木粒子装饰 (通过粒子系统或静态 sprite) |

#### 9.3.4 粒子效果

**新增**: working 节点上方漂浮粒子（表示"工作中"），道路上有流动光点（表示"数据流"），sleeping 时 Zzz 文字飘出。

```typescript
// 流动光点示例（RoadLayer 上叠加粒子）
class RoadParticleLayer {
    private particles: Graphics[] = [];
    update(delta: number) {
        for (const p of this.particles) {
            p.x += p.speed * delta;
            p.alpha = Math.sin(p.x * 0.05) * 0.5 + 0.5;
        }
    }
}
```

---

### 9.4 页面美化

#### 9.4.1 浮动工具栏 (FloatingDock)

**当前**: 7 个 Ant Design 按钮竖排，纯文字 tooltip。

**文件**: `WorldFloatingDock.tsx`

**方案**:
- 按钮改为磨砂玻璃效果 (`backdrop-filter: blur(8px)`)
- 当前活跃面板的按钮高亮（底部小圆点指示器）
- 休眠/唤醒按钮根据 being 状态切换图标和颜色
- 新增"定位"按钮合并进 dock（当前是独立 floating button）

#### 9.4.2 侧边面板统一设计语言

**当前**: 5 个独立的 Ant Design `Drawer`，各自不同的样式。

**文件**: `TaskPanel.tsx`, `ArtifactBoxPanel.tsx`, `StatusPanel.tsx`, `ActionLogPanel.tsx`, `BeingChatPanel.tsx`

**方案**:
- 统一面板头部样式（渐变背景 + being 状态 icon）
- 面板内容区统一 padding 和卡片风格
- 空状态插图（无任务时显示插画而不是空白）
- 列表项加 hover 效果和过渡动画

#### 9.4.3 对话面板 (BeingChatPanel) 体验优化

**当前**: 轮询模式 (2s 间隔查 action_logs)，体验割裂。

**文件**: `BeingChatPanel.tsx`

**方案**:
- 接入 WebSocket 实时推送
- 发送消息后立即显示"对方正在输入..."动画
- 消息气泡加圆角和阴影
- 支持快捷指令按钮（"今天做了什么"、"查看产物"）

#### 9.4.4 状态面板信息层次

**当前**: 显示 being 基本状态。

**文件**: `StatusPanel.tsx`

**方案**:
- 顶部大卡片展示 being 头像 + 名称 + 当前状态 (大号状态徽章)
- 进度环展示当前任务的完成百分比
- 时间线展示最近活动
- 统计卡片：今日完成任务数、产物数、移动距离

#### 9.4.5 响应式适配

**当前**: 固定布局，小屏幕上节点重叠。

**方案**:
- Canvas 区域响应式缩放（`resize` 监听 + debounce）
- 小屏 (< 768px) 时面板从 Drawer 改为全屏 Modal
- 小屏时 FloatingDock 从右侧竖排改为底部横排

---

### 9.5 功能完善

#### 9.5.1 实时状态推送 (WebSocket)

**当前**: 5s HTTP 轮询，延迟高，浪费带宽。

**方案**: 

1. 后端在 being 状态变化时 emit WebSocket event
2. 前端 `useDigitalWorldBootstrap` 订阅 WebSocket，收到事件后增量更新
3. 保留 HTTP 轮询作为 fallback（WebSocket 断开时自动切换）

#### 9.5.2 多 Being 支持

**当前**: `DigitalBeingData` 是单例（`mapApiToBeing` 取 `apiBeings[0]`）。世界只能有一个数字生命。

**文件**: `types.ts:26-34`, `useDigitalWorldBootstrap.ts:41-52`, `WorldApp.ts:46-48`

**方案**:
- `WorldApp` 维护 `Map<string, DigitalBeingEntity>` 替代单个 `_being`
- 每个 being 独立渲染、独立动画、独立状态
- 点击不同 being 打开独立的状态面板

#### 9.5.3 世界编辑器 (Dev Tool)

**新增功能**: 开发模式下可拖拽节点、添加/删除道路、保存布局。

**方案**:
- Dev 模式下节点可拖拽 (`pointerdown` → drag → `pointerup` 更新 position)
- 双击空白区域添加新节点
- 右键节点删除
- 导出/导入 JSON 布局文件

#### 9.5.4 主题切换

**当前**: 所有颜色硬编码 (`0xffffff`, `0xeef2f7` 等)。

**方案**:
- 定义 `ThemeColors` 接口（背景、网格、道路、节点、being）
- 提供亮色/暗色两套主题
- 通过 CSS 变量 + PixiJS 颜色常量联动

```typescript
interface WorldTheme {
    canvasBg: number;
    gridColor: number;
    roadColor: number;
    nodeBg: number;
    nodeBorder: number;
    textColor: number;
}
const lightTheme: WorldTheme = { canvasBg: 0xf8fafc, ... };
const darkTheme: WorldTheme = { canvasBg: 0x0f172a, ... };
```

#### 9.5.5 动画系统增强

**当前**: 线性插值移动 (`route-animation.ts`)，固定速度 120px/s。

**方案**:
- 缓动函数 (ease-in-out) 替代线性插值
- 节点间移动速度根据距离自适应（近距离慢走，远距离快跑）
- 转弯时加旋转过渡 (`setFacing` 渐变而非瞬间翻转)

#### 9.5.6 音效反馈

**新增**: 关键事件的声音反馈。

- 到达节点: 短促提示音
- 开始工作: 机械运转声
- 任务完成: 完成音效
- 错误: 警告音
- 所有音效可静音（设置面板开关）

#### 9.5.7 快捷键系统

**新增**: 键盘快捷键。

| 快捷键 | 功能 |
|--------|------|
| `F` | 定位 Being (Fit to view) |
| `H` | 回到 Home 节点 |
| `1-5` | 快速打开对应面板 |
| `Space` | 暂停/恢复动画 |
| `+/-` | 缩放 |

#### 9.5.8 状态转换动画

**当前**: `setStatus()` 直接切换视觉状态。

**方案**: 状态之间有过渡动画。
- idle → moving: 起身动画 (0.3s)
- moving → working: 到达 + 就位动画 (0.5s)
- working → idle: 伸展动画 (0.3s)
- idle → sleeping: 坐下 + 闭眼动画 (0.8s)

---

### 9.6 Digital World 优先级排序

#### 阶段一：P0 (核心优化)

| # | 优化项 | 文件 | 效果 |
|---|--------|------|------|
| 1 | 轮询 → WebSocket 实时推送 | `useDigitalWorldBootstrap.ts` + 后端 | 零延迟状态同步 |
| 2 | 渲染管线升级 (Texture 缓存) | `WorkstationNode.ts`, `WorldApp.ts` | 减少 CPU 绘制 |
| 3 | Canvas resize 防抖 | `useWorldApp.ts` | 避免高频重绘 |
| 4 | 寻路缓存 | `useBeingMovement.ts` | 省每次 graph 重建 |

#### 阶段二：P1 (视觉美化)

| # | 优化项 | 效果 |
|---|--------|------|
| 5 | Being 实体视觉升级 (Q版比例+渐变着色) | 核心视觉焦点更精致 |
| 6 | 工作站节点视觉升级 (阴影+发光) | 每个节点更有质感 |
| 7 | 环境美化 (渐变背景+双线道路) | 世界不再"朴素" |
| 8 | 浮动工具栏磨砂玻璃效果 | 现代 UI 风格 |

#### 阶段三：P2 (功能完善)

| # | 优化项 | 效果 |
|---|--------|------|
| 9 | 状态转换动画系统 | 移动/工作/休眠之间有过渡 |
| 10 | 多 Being 支持 | 多人协作场景 |
| 11 | 粒子效果 (工作火花+数据流) | 视觉反馈更生动 |
| 12 | 对话面板实时化 (WebSocket) | 不再 2s 轮询 |
| 13 | 暗色主题 | 护眼/夜间模式 |
| 14 | 快捷键系统 | 高效操作 |

#### 阶段四：P3 (长期)

| # | 优化项 |
|---|--------|
| 15 | 世界编辑器 (Dev Tool) |
| 16 | 音效系统 |
| 17 | 移动端响应式 |
| 18 | 自定义布局持久化 |
| 19 | 3D 视角探索 (PixiJS → Three.js 迁移评估) |

---

## 附录 B：Digital World 文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `DigitalWorld.tsx` | 119 | 容器组件，组装 Canvas + UI |
| `canvas/WorldApp.ts` | ~400 | PixiJS App 生命周期 + 世界绘制 |
| `canvas/DigitalBeingEntity.ts` | ~350 | 数字生命实体 + 6 种动画 |
| `canvas/WorkstationNode.ts` | 302 | 6 种工作站节点绘制 |
| `canvas/CameraController.ts` | 157 | 拖拽平移 + 滚轮缩放 |
| `canvas/WorldGrid.ts` | 29 | 网格背景 |
| `canvas/RoadLayer.ts` | 33 | 道路连线 |
| `canvas/StatusBubbleLayer.ts` | 76 | 状态气泡 |
| `hooks/useWorldApp.ts` | ~50 | PixiJS App 挂载/销毁 |
| `hooks/useBeingMovement.ts` | 67 | 寻路 + 动画触发 |
| `hooks/useDigitalWorldBootstrap.ts` | 145 | 数据加载 + 轮询 |
| `path/graph.ts` | ~40 | 图构建 |
| `path/dijkstra.ts` | ~40 | 最短路径 |
| `path/route-animation.ts` | 134 | 路径插值动画 |
| `components/WorldFloatingDock.tsx` | 42 | 浮动工具栏 |
| `components/BeingChatPanel.tsx` | ~120 | 对话面板 |
| `components/TaskPanel.tsx` | 91 | 任务面板 |
| `components/ArtifactBoxPanel.tsx` | ~60 | 产物面板 |
| `components/StatusPanel.tsx` | 86 | 状态面板 |
| `components/ActionLogPanel.tsx` | ~80 | 日志面板 |
| `mock/mockWorld.ts` | ~120 | Mock 数据 |
| `types.ts` | 34 | 类型定义 |
| `constants.ts` | 7 | 视觉常量 |
