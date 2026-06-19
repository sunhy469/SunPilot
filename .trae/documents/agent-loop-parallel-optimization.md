# Agent Loop 并行化优化方案

## 摘要

当前 SunPilot 的 Agent Loop 采用全串行架构：用户消息到达后，依次执行上下文构建 → 意图路由 → 规划 → 工具决策 → LLM 推理，首 token 延迟 1-3 秒。本方案通过三个层次的并行化，将首 token 延迟降至 <500ms，同时保留精准上下文的优势。

---

## 现状分析

### 当前串行流程（首 token 延迟 = 所有阶段之和）

```
用户消息 → contextBuilder.build() [500-800ms]
         → intentRouter.route()    [50-500ms]
         → maybeCreatePlan()       [0-500ms]
         → decideTools()           [50-200ms]
         → runContentBlockLoop()   [TTFT 200-500ms]
         → 首 token
```

总首 token 延迟：**800-2500ms**

### 瓶颈根因

1. **contextBuilder.build() 内部 9 个 IO 全串行**（L221-L665），其中 embedText(50-500ms) 是最大延迟源
2. **LLM 推理必须等所有预处理完成**才能启动
3. **listSkills() 在 build/decideTools/executeStreaming 中重复调用 3 次**
4. **intentRouter 内 skill embedding 串行循环**（L174-183）

---

## 优化方案：三层并行化

### 第一层：ContextBuilder 内部 IO 并行化

**目标**：将 build() 耗时从 500-800ms 降至 200-300ms

**改动文件**：`packages/core/src/agent-kernel/context/context-builder.ts`

**具体改动**：

将当前串行的 IO 操作按依赖关系分组并行执行：

```
当前（串行）：
  listMessages → searchMemories(摘要) → stale检测 → embedText → searchMemories(混合) → searchMemories(向量) → listArtifacts → listToolResults → listSkills

优化后（并行分组）：
  ┌─ Group A（无依赖，立即并行启动）──────────────────┐
  │  • listMessages()                                  │
  │  • searchMemories(摘要, query="")                   │
  │  • embedText(input.message)                         │
  │  • listArtifacts(runId)                             │
  │  • listToolResults(runId)                           │
  │  • listSkills()                                     │
  └────────────────────────────────────────────────────┘
                          ↓ 全部完成后
  ┌─ Group B（依赖 Group A 结果）──────────────────────┐
  │  • staleDetection（依赖 summary + messages）         │
  │  • searchMemories(混合, 依赖 embedding)              │
  │  • searchMemories(向量, 依赖 embedding)  ← 与混合并行 │
  └────────────────────────────────────────────────────┘
                          ↓
  ┌─ Group C（依赖所有结果）────────────────────────────┐
  │  • token budget 应用                                 │
  │  • 组装 AgentContext                                 │
  └────────────────────────────────────────────────────┘
```

**实现方式**：

在 `build()` 方法中，将 L221-L665 的串行 IO 替换为：

```typescript
// Group A: 并行启动所有无依赖 IO
const [
  messages,
  summaryMemories,
  queryEmbedding,
  artifacts,
  toolResults,
  skills,
] = await Promise.all([
  this.deps.listMessages(input.conversationId, MAX_HISTORY_MESSAGES).catch(() => []),
  this.deps.searchMemories({ query: "", ...types: ["conversation_summary"] }).catch(() => []),
  this.deps.embedText?.(input.message).catch(() => undefined),
  this.deps.listArtifacts?.(input.runId).catch(() => []),
  this.deps.listToolResults?.(input.runId).catch(() => []),
  this.deps.listSkills?.().catch(() => []),
]);

// Group B: 并行执行依赖 Group A 的操作
const [staleResult, hybridMemories, vectorMemories] = await Promise.all([
  this.runStaleDetection(summaryMemories, messages, input),  // 从 build 中提取
  this.deps.searchMemories({ query: input.message, embedding: queryEmbedding, ... }),
  queryEmbedding
    ? Promise.race([
        this.deps.searchMemories({ query: "", embedding: queryEmbedding, ... }),
        new Promise(resolve => setTimeout(() => resolve([]), 2000)),
      ])
    : Promise.resolve([]),
]);
```

**预估收益**：build() 耗时从 ~600ms 降至 ~200ms（取决于最慢的 IO）

---

### 第二层：LLM 预推理与上下文构建并行（核心创新）

**目标**：首 token 延迟从 800-2500ms 降至 <500ms

**改动文件**：
- `packages/core/src/agent-kernel/agent-loop-engine.ts`（主要改动）
- `packages/core/src/agent-kernel/loop-types.ts`（新增类型）

**核心思路**：

用户消息到达后，**立即启动 LLM 预推理**（只有用户消息 + system prompt，无上下文），同时**并行执行上下文构建**。LLM 预推理的输出有两个用途：

1. **首 token 快速展示**：用户几乎立刻看到 LLM 的思考文字（如"我来帮你搜索这个相机的货源..."）
2. **提取工具匹配线索**：从预推理输出中提取意图/工具匹配参数，注入后续的工具决策路径，加速工具匹配

**具体流程**：

```
用户消息到达
  │
  ├─ 线程 A：LLM 预推理（立即启动）
  │    输入：system prompt + 用户消息（无上下文）
  │    输出：
  │      ① 流式文本 → 前端首 token（<500ms）
  │      ② 预推理完成后提取：
  │         - preliminaryIntent: 初步意图（如 "product_source_search"）
  │         - toolHints: 工具匹配线索（如 { category: "1688", productType: "camera" }）
  │         - keyEntities: 关键实体（如 ["相机", "货源", "销量"]）
  │
  ├─ 线程 B：上下文构建 + 意图路由（并行执行）
  │    输入：AgentLoopInput
  │    输出：AgentContext + RoutedIntent
  │
  └─ 汇合点：两个线程都完成后
       │
       ├─ 如果线程 A 的预推理已产出工具匹配线索：
       │    → 将 toolHints 注入 decideTools() 的 prioritySkills 参数
       │    → 跳过 intentRouter 的 LLM 分类层（Layer 2），直接用预推理结果
       │
       ├─ 如果线程 B 的上下文构建已完成：
       │    → 用完整上下文启动第二轮 LLM 推理（有上下文的正式回答）
       │    → 第二轮 LLM 的输出替换/补充第一轮的预推理文本
       │
       └─ 进入 runContentBlockLoop() 正常流程
```

**实现细节**：

#### 1. 新增 `PreliminaryInferenceResult` 类型

在 `loop-types.ts` 中添加：

```typescript
export interface PreliminaryInferenceResult {
  /** 预推理的流式文本内容 */
  text: string;
  /** 从预推理中提取的初步意图 */
  preliminaryIntent?: {
    type: string;
    confidence: number;
    candidateSkills?: string[];
  };
  /** 工具匹配线索，用于加速后续 decideTools */
  toolHints?: Array<{
    skillId: string;
    reason: string;
    argumentsHint?: Record<string, unknown>;
  }>;
  /** 从用户消息中提取的关键实体 */
  keyEntities?: string[];
}
```

#### 2. 修改 `AgentLoopEngine.run()` 方法

将当前的串行流程改为并行：

```typescript
async run(input: AgentLoopInput, signal: AbortSignal): Promise<AgentLoopResult> {
  const messageId = `msg_${crypto.randomUUID()}`;

  // ① 立即发出 agent.message.started（保持不变）
  this.deps.eventBus.emit("agent.message.started", ...);

  // ② 并行启动：LLM 预推理 + 上下文构建
  const preliminaryPromise = this.runPreliminaryInference(input, messageId, signal);
  const contextPromise = this.buildContextAndIntent(input, signal);

  // ③ 等待上下文构建完成（预推理的流式输出已在进行中）
  const { context, intent } = await contextPromise;

  // ④ 获取预推理结果（通常此时已完成或接近完成）
  const preliminary = await preliminaryPromise;

  // ⑤ 将预推理的工具线索注入后续流程
  const plan = await this.maybeCreatePlan(input, context, intent, signal);
  const decision = await this.decideTools(
    input, context, intent, plan, signal,
    undefined,  // previousObservation
    preliminary?.toolHints,  // ← 注入预推理线索
  );

  // ⑥ 进入正式的 content block loop
  //    如果预推理已产出文本，stream 中已有内容
  //    第二轮 LLM 推理将基于完整上下文
  return this.runContentBlockLoop(
    input, context, intent, plan, decision, messageId, signal,
    preliminary,  // ← 传入预推理结果
  );
}
```

#### 3. 新增 `runPreliminaryInference()` 方法

```typescript
private async runPreliminaryInference(
  input: AgentLoopInput,
  messageId: string,
  signal: AbortSignal,
): Promise<PreliminaryInferenceResult> {
  // 构建最小 prompt：system + 用户消息
  const messages = [
    { role: "system" as const, content: this.buildPreliminarySystemPrompt() },
    { role: "user" as const, content: input.message },
  ];

  // 创建流式输出（前端立即看到首 token）
  const stream = new AssistantMessageStream({
    runId: input.runId,
    conversationId: input.conversationId,
    messageId,
    eventBus: this.deps.eventBus,
    saveMessage: this.deps.saveMessage!,
    skipStartedEvents: true,
  });
  stream.start();
  const textPart = stream.startTextPart();

  let fullText = "";
  try {
    for await (const chunk of this.deps.modelRouter.streamChat({ messages })) {
      stream.appendText(textPart.id, chunk.delta);
      fullText += chunk.delta;
    }
  } catch {
    // 预推理失败不影响主流程
  }

  stream.completeTextPart(textPart.id);

  // 从预推理文本中提取工具匹配线索
  const toolHints = this.extractToolHints(fullText, input);

  return { text: fullText, toolHints };
}
```

#### 4. 预推理 System Prompt 设计

```typescript
private buildPreliminarySystemPrompt(): string {
  return `You are SunPilot, a concise assistant. The user just sent a message.
Your task:
1. Briefly acknowledge what the user is asking (1-2 sentences)
2. If the user seems to want a tool/action, indicate what tool category would help

Keep your response SHORT (2-3 sentences max). Do NOT attempt to answer fully —
you will receive full context shortly for a complete response.

Available tool categories: product sourcing, price comparison, order management,
image analysis, web search, data analysis.`;
}
```

#### 5. `extractToolHints()` 方法

从预推理输出中提取结构化工具线索，用于加速后续 `decideTools()`：

```typescript
private extractToolHints(
  preText: string,
  input: AgentLoopInput,
): PreliminaryInferenceResult["toolHints"] {
  // 方案 A（简单）：基于关键词匹配
  // 方案 B（推荐）：用一次快速 LLM 结构化调用提取
  // 初期实现方案 A，后续升级方案 B
  const hints: Array<{ skillId: string; reason: string; argumentsHint?: Record<string, unknown> }> = [];

  // 基于预推理文本中的关键词匹配 skill
  // 例如：预推理说"我来帮你搜索货源" → 匹配 product.source.search1688
  // 这比 intentRouter 的 4 层级联快得多

  return hints.length > 0 ? hints : undefined;
}
```

#### 6. 修改 `runContentBlockLoop()` 接收预推理结果

```typescript
private async runContentBlockLoop(
  input: AgentLoopInput,
  context: AgentContext,
  intent: RoutedIntent,
  plan: AgentPlan | undefined,
  decision: ToolDecision,
  messageId: string,
  signal: AbortSignal,
  preliminary?: PreliminaryInferenceResult,  // ← 新增参数
): Promise<AgentLoopResult> {
  // 如果已有预推理的 stream 内容，复用同一个 stream
  // 否则创建新 stream（保持现有逻辑）
  const stream = preliminary
    ? this.resumePreliminaryStream(input, messageId, preliminary)
    : new AssistantMessageStream({ ... });

  // ... 后续逻辑不变，但第二轮 LLM 推理时已有完整上下文
  // 预推理的文本作为 "thinking" part 保留
  // 正式回答作为新的 text part 追加
}
```

---

### 第三层：消除重复调用 + IntentRouter 内部并行

**目标**：消除冗余 IO，进一步减少 100-300ms

**改动文件**：
- `packages/core/src/agent-kernel/agent-loop-engine.ts`
- `packages/core/src/agent-kernel/intent/intent-router.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts`

#### 3.1 listSkills() 全局只调一次

当前 `listSkills()` 在 build()、decideTools()、executeStreaming() 中各调一次（共 3 次）。

**改动**：在 `run()` 顶层调用一次，通过参数传递：

```typescript
async run(input: AgentLoopInput, signal: AbortSignal): Promise<AgentLoopResult> {
  // 最早启动，与其他并行操作一起
  const skillsPromise = this.deps.contextBuilder["deps"].listSkills();

  // ... 并行执行 ...

  const skills = await skillsPromise;
  // 传入 context、decideTools、executeStreaming
}
```

#### 3.2 IntentRouter skill embedding 并行化

当前 `matchSkillWithEmbedding()` 中 L174-183 对每个 skill 串行调用 `embed()`：

```typescript
// 当前（串行）
for (const skill of skills) {
  const skillEmb = await embeddingService.embed(skillText);
  // ...
}
```

改为：

```typescript
// 优化后（并行）
const skillEmbeddings = await Promise.all(
  skills.map(skill => embeddingService.embed(skillToText(skill)))
);
```

由于 `LlmEmbeddingService` 有缓存，预热后的 skill embedding 命中率高，并行化后首次未缓存的场景收益最大。

#### 3.3 预推理线索跳过 IntentRouter Layer 2

当 `runPreliminaryInference()` 已产出 `toolHints` 且 confidence 足够高时，`intentRouter.route()` 可跳过 Layer 2（LLM 分类），直接使用预推理结果：

```typescript
// 在 intentRouter.route() 开头添加
if (preliminaryHints && preliminaryHints.length > 0) {
  const topHint = preliminaryHints[0];
  if (topHint.confidence >= 0.85) {
    return {
      type: "automation_execution",
      confidence: topHint.confidence,
      candidateSkills: preliminaryHints.map(h => h.skillId),
      requiresPlanning: false,
      requiresTool: true,
      // ...
    };
  }
}
```

---

## 优化后完整流程

```
用户消息到达
  │
  ├─ emit agent.message.started（立即，0ms）
  │
  ├─ 并行启动 ──────────────────────────────────────────────┐
  │                                                          │
  │  线程 A：LLM 预推理                                       │
  │    ├─ system prompt + 用户消息 → LLM 流式输出              │
  │    ├─ 首 token 到达前端（<500ms）                          │
  │    ├─ 用户看到"我来帮你搜索这个相机的货源..."                 │
  │    └─ 提取 toolHints: { skillId: "search1688", ... }      │
  │                                                          │
  │  线程 B：上下文构建（内部并行）                              │
  │    ├─ Group A: listMessages + embedText + listArtifacts    │
  │    │         + listToolResults + listSkills + searchSummary │
  │    └─ Group B: stale检测 + memory搜索(混合+向量并行)         │
  │                                                          │
  └─ 汇合（~300-500ms）──────────────────────────────────────┘
       │
       ├─ maybeCreatePlan()（可选，~0-200ms）
       │
       ├─ decideTools()（有 toolHints 加速，跳过 LLM 分类）
       │
       └─ runContentBlockLoop()
            ├─ 复用预推理 stream（已有文本）
            ├─ 基于完整上下文的第二轮 LLM 推理
            │   → 正式回答 + 工具调用
            └─ 正常流式循环
```

**首 token 延迟**：从 800-2500ms → **<500ms**
**总任务完成时间**：基本不变或略优（toolHints 加速了工具匹配）

---

## 前端状态映射调整

**改动文件**：`packages/web/src/pages/ChatPage/components/AssistantMessage.tsx`

并行化后，前端状态映射需要适配新的流程：

| 阶段 | 后端状态 | 前端显示 | 变化说明 |
|------|---------|---------|---------|
| LLM 预推理流式输出 | created → context_building | "正在思考" + 流式文本 | **新增**：预推理文本流式展示 |
| 上下文构建完成 | intent_routing | "正在思考" | 无变化 |
| 工具匹配完成 | executing | "正在调用工具: {name}" | 无变化 |
| 第二轮 LLM 推理 | responding | 流式正式回答 | **新增**：正式回答追加在预推理之后 |

前端需要区分"预推理文本"和"正式回答文本"：
- 预推理文本 → 作为 `thinking` part（可折叠的思考过程）
- 正式回答 → 作为 `text` part（主内容区）

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 预推理与正式回答内容矛盾 | 预推理 system prompt 明确要求"不要尝试完整回答"；预推理文本标记为 thinking part |
| 预推理消耗额外 token | 预推理使用最小 prompt（~200 token），总增量 <5%；可选用更快/更便宜的模型 |
| 并行化增加代码复杂度 | 分层实施：先做第一层（ContextBuilder 并行），验证后再做第二层（LLM 预推理） |
| 预推理失败 | 预推理是 best-effort，失败不影响主流程；contextPromise 独立完成 |
| 事件顺序保证 | 预推理的 stream 事件和正式回答的 stream 事件使用同一个 messageId，前端按 sequence 排序 |
| AbortSignal 处理 | 两个并行线程共享同一个 AbortSignal，取消时同时终止 |

---

## 实施计划

### Phase 1：ContextBuilder 内部并行化（低风险，高收益）

**改动文件**：
1. `packages/core/src/agent-kernel/context/context-builder.ts` — 重构 build() 为并行分组
2. `packages/core/src/agent-kernel/context/context-builder.ts` — 提取 staleDetection 为独立方法

**验证**：
- 单元测试：build() 返回的 AgentContext 结构不变
- 集成测试：console.debug 中的 `total_build_ms` 从 ~600ms 降至 ~200ms
- 回归测试：端到端对话功能正常

### Phase 2：消除重复调用 + IntentRouter 并行（低风险，中收益）

**改动文件**：
1. `packages/core/src/agent-kernel/agent-loop-engine.ts` — 顶层调用 listSkills()，传递给下游
2. `packages/core/src/agent-kernel/intent/intent-router.ts` — skill embedding 改为 Promise.all
3. `packages/core/src/agent-kernel/tools/tool-decision-engine.ts` — 接收外部 skills 参数

**验证**：
- listSkills() 调用次数从 3 降至 1
- IntentRouter Layer 1 耗时从 N×50ms 降至 ~100ms

### Phase 3：LLM 预推理并行（核心创新，中风险，最高收益）

**改动文件**：
1. `packages/core/src/agent-kernel/loop-types.ts` — 新增 PreliminaryInferenceResult 类型
2. `packages/core/src/agent-kernel/agent-loop-engine.ts` — 重构 run() 为并行，新增 runPreliminaryInference()、extractToolHints()
3. `packages/core/src/agent-kernel/assistant-message-stream.ts` — 支持从预推理恢复
4. `packages/web/src/pages/ChatPage/components/AssistantMessage.tsx` — 区分 thinking part 和 text part
5. `packages/web/src/pages/ChatPage/hooks/useChat.ts` — 适配新的事件流

**验证**：
- 首 token 延迟从 800-2500ms 降至 <500ms
- 预推理文本正确显示为思考过程
- 正式回答正确追加在预推理之后
- 工具匹配路径正确使用 toolHints
- AbortSignal 取消时两个线程都正确终止

---

## 假设与决策

1. **预推理使用同一模型** vs **使用更快/更便宜的模型**：初期使用同一模型（简化实现），后续可切换到更快的模型（如 o4-mini）做预推理
2. **预推理文本展示方式**：作为 thinking part（可折叠），而非直接作为正式回答
3. **extractToolHints 初期用关键词匹配**，后续升级为 LLM 结构化提取
4. **并行化不改变状态机定义**：AgentLoopStatus 枚举不变，只是执行时序从串行变为并行
5. **前端无需新增事件类型**：复用现有的 `agent.message.part.*` 事件，通过 part type 区分 thinking 和 text
