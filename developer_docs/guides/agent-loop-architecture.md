# Agent Loop 核心架构

## 整体流程

```
用户消息
  │
  ├─ ① 预推理 (PreliminaryInference)  ←── 并行执行
  │     • 轻量级 LLM 调用 (intent_classification)
  │     • 输出: 思考文本(写入stream) + JSON路由提示
  │     • 与上下文构建并行，不阻塞主流程
  │
  ├─ ② 上下文构建 + 意图路由
  │     • 加载对话历史、记忆、可用技能
  │     • 意图路由: 确定 user_skill / casual_chat / ...
  │
  ├─ ③ 工具决策 (ToolSelector)
  │     • 匹配技能 → 构建 PlannedToolCall[]
  │     • 决策类型: use_tool / no_tool / ask_clarification
  │
  ├─ ④ [如有工具] NativeToolLoop → ReAct 循环
  │     • LLM 带工具调用 → 输出思考文本 + tool_calls
  │     • 执行工具 → 注入结果 → 下一轮 LLM
  │     • 工具失败 → 注入重试提示 → LLM 自主决定是否重试
  │     • LLM 不调用工具 → 文本即为最终回答
  │
  └─ ⑤ [无工具] ResponseComposer → 直接生成回复
```

---

## 1. 主入口: AgentLoopEngine.run()

**文件**: `packages/core/src/agent-kernel/agent-loop-engine.ts`

```typescript
async run(input: AgentLoopInput, signal: AbortSignal): Promise<AgentLoopResult> {
  // ── Step 1: 创建 AssistantMessageStream（尽早创建，前端立刻看到消息卡片）──
  const stream = new AssistantMessageStream({
    runId, conversationId, messageId,
    eventBus: this.deps.eventBus,
    saveMessage: this.deps.saveMessage,
  });
  // 发送 agent.message.started 事件 → 前端创建助手消息卡片
  stream.start();
  stream.startStatus({ label: "正在理解需求..." });

  // ── Step 2: 启动预推理（与上下文构建并行） ──
  // 预推理使用轻量级 prompt，只含用户消息，不含完整上下文
  // 输出思考文本（写入 stream 的 progress text part）+ JSON 路由提示
  const preliminaryPromise = this.preliminaryInference.run(input, signal, stream);

  // ── Step 3: 构建上下文 + 意图路由 ──
  // 上下文包含: 对话历史、记忆、可用技能、系统提示等
  const { context, intent } = await this.runPreparation.buildContextAndIntent(
    input, signal, undefined, preliminaryPromise
  );

  // ── Step 4: 获取预推理结果（最多等 200ms） ──
  const preliminary = await racePreliminaryWithTimeout(preliminaryPromise, 200);

  // ── Step 5: 工具决策 ──
  const decision = await this.runPreparation.decideTools(
    input, context, intent, plan, signal,
    undefined,                     // previousObservation
    preliminary?.toolHints,        // 预推理的工具提示作为 prioritySkills
  );

  // ── Step 6: 根据决策类型分发 ──
  switch (decision.type) {
    case "use_tool":
    case "no_tool": {
      // §ReAct: 预推理已有思考文本 + 工具已确定 → 跳过第一轮 LLM
      const hasPreInferenceThinking = !!preliminary?.thinkingText?.trim();
      const skipFirstLlmTurn =
        decision.type === "use_tool" &&
        hasPreInferenceThinking &&
        (decision.toolCalls?.length ?? 0) > 0;

      return this.runContentBlockLoop(
        input, context, intent, plan, decision,
        messageId, signal, stream,
        skipFirstLlmTurn || undefined,
      );
    }
    case "ask_clarification":
      return this.runOutcomes.handleClarification(...);
    case "require_approval":
      return this.approvalFlow.runApprovalWithStream(...);
  }
}
```

### skipFirstLlmTurn 决策逻辑

```
预推理有思考文本?
  ├─ YES → 思考文本已在 stream 中（用户可见）
  │       工具已匹配?
  │         ├─ YES → skipFirstLlmTurn = true  ← 跳过 LLM，直接执行工具
  │         └─ NO  → 正常走 tool loop
  └─ NO  → 正常走 tool loop（LLM 第一轮决定工具）
```

效果：有工具场景从 3 次 LLM 调用 → 2 次（预推理 1 次 + 结果合成 1 次）

---

## 2. 预推理: PreliminaryInferenceService

**文件**: `packages/core/src/agent-kernel/agent-loop-engine/preliminary-inference.ts`

```typescript
async run(input, signal, stream?) {
  // ── 构建轻量级 prompt ──
  // 只含用户消息 + 系统提示，不含上下文（所以能并行执行）
  const messages = [
    { role: "system", content: buildPreliminarySystemPrompt() },
    { role: "user", content: input.message },
  ];

  // ── 调用 LLM (intent_classification) ──
  let fullText = "";
  for await (const chunk of modelRouter.streamChat("intent_classification", { messages }, signal)) {
    fullText += chunk.delta;
  }

  // ── 分割思考文本 + JSON ──
  // LLM 输出: "我去1688搜索这件衬衫的同款货源。\n{"intentCategory":"product_search",...}"
  const { thinkingText, jsonText } = splitThinkingAndJson(fullText);
  //   思考文本部分 ↑                      JSON 部分 ↑

  // ── 解析 JSON 获取路由提示 ──
  const { intentType, intentConfidence, toolHints } = parsePreInferenceResponse(jsonText);

  // ── §ReAct: 思考文本写入 stream 作为 progress text part ──
  // 用户实时看到 LLM 的自然语言思考，不再用模板 "我先调用xxx"
  if (stream && thinkingText) {
    const part = stream.startTextPart("progress");
    stream.appendText(part.id, thinkingText);
    stream.completeTextPart(part.id);
  }

  return { text: fullText, thinkingText, toolHints, intentType, intentConfidence };
}
```

### splitThinkingAndJson() — 分割思考文本与 JSON

```typescript
private splitThinkingAndJson(fullText: string) {
  // 找到 JSON 起始位置（第一个 {）
  const jsonStart = fullText.indexOf("{");
  if (jsonStart <= 0) return { jsonText: fullText };

  // 提取思考文本（JSON 之前的部分）
  let thinkingText = fullText.slice(0, jsonStart).trim();

  // 清理 LLM 可能 echo 的 prompt 标签
  thinkingText = thinkingText
    .replace(/^PART\s*1\s*[-:.]?\s*/i, "")
    .replace(/^Thinking\s*[:：]\s*/i, "")
    .replace(/PART\s*2\s*[-:.]?\s*Routing\s*JSON\s*[:：]?\s*/gi, "")
    .replace(/Routing\s*JSON\s*[:：]\s*/gi, "")
    .trim();

  const jsonText = fullText.slice(jsonStart).trim();
  return { thinkingText: thinkingText || undefined, jsonText };
}
```

---

## 3. NativeToolLoop: ReAct 工具循环

**文件**: `packages/core/src/agent-kernel/tools/tool-decision-engine/native-tool-loop-executor.ts`

### executeStreaming() — 主入口

```typescript
async executeStreaming(input, signal) {
  const { runId, conversationId, context, intent, toolSkillIds, stream, skipFirstLlmTurn } = input;

  // ── 1. 构建初始消息（首轮 slim 模式，不含记忆） ──
  let currentMessages = buildStreamingMessages(context, plan, prioritySkills, { slim: true });

  // ── 2. 加载技能目录 ──
  const allSkills = await listSkills();

  // ── 3. 构建工具定义（LLM function calling schema） ──
  //    优先使用 ToolSelector 预匹配的技能
  const { tools, nameMap } = buildStreamingToolDefinitions(retrieval, intent);

  // ── 4. 循环变量 ──
  let iteration = 0;
  let retryHintInjected = false;           // ← 防止重复注入重试提示
  const maxIterations = computeMaxIterations(intent, plan);  // 默认 5
```

### skipFirstLlmTurn — 跳过冗余的第一轮 LLM

```typescript
  // §ReAct: 预推理已经确定工具 + 写入思考文本 → 跳过 LLM 第一轮
  if (skipFirstLlmTurn && toolSkillIds && toolSkillIds.length > 0) {
    iteration = 1;  // 标记第一轮已完成

    // 从 skill ID 反查 function name，构造合成 tool calls
    const syntheticToolCalls = [];
    for (const skillId of toolSkillIds) {
      // 在 nameMap 中查找 function name
      for (const [fnName, sId] of nameMap) {
        if (sId === skillId) { functionName = fnName; break; }
      }
      syntheticToolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        type: "function",
        function: { name: functionName, arguments: "{}" },  // 空参数，由 ToolArgumentBuilder 填充
      });
    }

    // 去重检查
    for (const tc of syntheticToolCalls) {
      const sig = `${skillId}:${stableStringifyArgs(tc.function.arguments)}`;
      if (seenToolCallSignatures.has(sig)) { /* duplicate — skip */ }
      seenToolCallSignatures.add(sig);
    }

    // ── 直接执行工具（算法路径，无 LLM 调用） ──
    const toolResults = await toolCallExecutor.execute(
      runId, conversationId, syntheticToolCalls, nameMap,
      context, intent, allSkills, signal, stream, permissionMode,
    );

    // 处理结果: approvalRequired / deterministic stop / final projections
    if (toolResults.stop) { /* 确定性错误 → 直接返回 */ }
    if (finalProjections.length > 0) { /* 工具输出即最终答案 → 直接返回 */ }

    // 注入工具结果到消息中 → 为 LLM 合成轮准备
    currentMessages = injectStreamingToolResults(
      currentMessages, syntheticToolCalls,
      { summaries: toolResults.summaries, artifacts: toolResults.artifacts },
    );
    // ↓ 继续进入 while 循环，LLM 合成最终回复
  }
```

### while 循环 — ReAct 核心

```typescript
  // ── 5. ReAct 循环 ──
  while (iteration < maxIterations) {
    if (signal.aborted) break;
    iteration++;

    // ── 5a. LLM 调用（带工具） ──
    // LLM 自主决定: 输出思考文本 + 调用工具 或 直接输出最终回答
    const result = await this.streamLlmTurn(
      runId, conversationId, messageId,
      currentMessages,    // 包含上下文 + 工具结果
      tools,              // 始终带工具，不没收
      signal, modelId, stream,
      undefined,          // 延迟创建 text part
      "progress",         // 工具前的文本标记为 "progress"（思考过程）
    );

    fullContent += result.textContent;

    // ── 5b. 无 tool_calls → LLM 认为任务完成 → 退出 ──
    if (result.toolCalls.length === 0) {
      // 提升 text part 角色: "progress" → "final"
      if (stream && result.textPartId) {
        stream.updateTextPartRole(result.textPartId, "final");
      }
      break;  // ← 自然退出，文本即为最终回答
    }

    // ── 5c. 去重检查 ──
    let duplicateBlocked = false;
    for (const tc of result.toolCalls) {
      const sig = `${skillId}:${stableStringifyArgs(tc.function.arguments)}`;
      if (seenToolCallSignatures.has(sig)) duplicateBlocked = true;
      seenToolCallSignatures.add(sig);
    }
    if (duplicateBlocked) break;

    // ── 5d. 执行工具 ──
    const toolResults = await toolCallExecutor.execute(
      runId, conversationId, result.toolCalls, nameMap,
      context, intent, allSkills, signal, stream, permissionMode,
    );

    // 确定性错误（缺少参数、权限拒绝、schema 校验失败）→ 退出
    if (toolResults.stop) {
      stream.startTextPart("final"); /* error text */ ...;
      break;
    }

    // 直接最终投影（工具输出即最终答案）→ 退出
    if (finalProjections.length > 0) {
      stream.startTextPart("final"); /* projection text */ ...;
      break;
    }

    // ── 5e. 注入工具结果 → 下一轮 LLM 可以看到 ──
    currentMessages = injectStreamingToolResults(
      currentMessages, result.toolCalls, toolResults, maxContextTokens,
    );

    // ── 5f. §ReAct: 工具失败重试 ──
    const allFailed = toolResults.summaries.every(s => s.status !== "completed");

    if (allFailed && iteration < maxIterations && !retryHintInjected) {
      retryHintInjected = true;  // 只注入一次

      // 注入系统提示，告知 LLM 可以重试
      // LLM 自主决定：调用工具（重试）或 输出文本（向用户解释）
      currentMessages = [
        ...currentMessages,
        {
          role: "system",
          content: "工具调用未成功完成。如果需要，你可以重试调用工具；" +
                   "如果无法重试，请向用户解释原因。",
        },
      ];
      // ↓ 继续循环 → LLM 在下一轮带着工具决定是否重试
    }
  } // end while
```

### 工具失败重试的关键设计

```
工具全部失败
  │
  ├─ 是确定性错误? (toolResults.stop)
  │   └─ YES → break（参数错误、权限拒绝等不应重试）
  │
  ├─ 已注入过重试提示? (!retryHintInjected)
  │   └─ YES → 不再注入，正常循环
  │
  └─ 注入 system hint: "工具调用未成功完成，你可以重试或向用户解释"
       │
       └─ 继续 while 循环:
            LLM 带工具被调用
              ├─ LLM 调用工具 → 重试 → 正常流程
              └─ LLM 不调用工具 → result.toolCalls.length === 0 → break
                                  LLM 的文本就是最终解释
```

**核心原则**:
- **不没收工具** — LLM 始终有工具可用
- **不强制 break** — 让 LLM 自己决定是重试还是放弃
- **只提示一次** — `retryHintInjected` 防止重复注入
- **确定性错误直接退出** — 参数错误、权限拒绝不重试

---

## 4. ResponseComposer — 无工具路径

**文件**: `packages/core/src/agent-kernel/response/response-composer.ts`

```typescript
async composeDirect(input, signal) {
  // 构建消息: 系统提示 + 记忆 + 对话历史 + 用户消息
  const messages = buildMessages(input.context, input.intent);

  // 调用 LLM 流式生成（无工具）
  for await (const chunk of llm.streamChat({ messages })) {
    content += chunk.delta;
    stream.appendText(textPartId, chunk.delta);  // 实时推送到前端
  }

  return { messageId, content };
}
```

只有当意图不需要工具（如 `casual_chat`、`question_answering`）时才走此路径。

---

## 5. 事件流: 后端 → WebSocket → 前端

```
rawEventBus (内部事件总线)
  │
  │  subscriber: persistence-factory.ts 桥接
  │
  ├─ Sync 直通 (不持久化):
  │   • agent.message.started      ← 保证 message 容器先创建
  │   • agent.message.part.started  ← 保证 part 容器先创建
  │   • agent.message.part.delta    ← 实时文本内容
  │   → liveEventBus.publish(event) → WebSocket → 前端
  │
  └─ Async 持久化 (DB 写入后转发):
      • agent.run.*, agent.tool.*, ... 等所有其他事件
      → eventSink.persist(event) → liveEventBus.publish(persisted)
      → WebSocket → 前端
```

**关键**: lifecycle 事件（message/part started）和 delta 事件必须同步直通，因为前端需要按顺序接收 `message.started → part.started → part.delta`。如果 `message.started` 走异步持久化，`part.delta` 可能先到达，前端会因为 message 容器未创建而丢弃 delta。

**文件**: `packages/daemon/src/factories/persistence-factory.ts`

---

## 6. semanticRole: progress vs final

文本 part 的 `semanticRole` 决定前端渲染位置：

| semanticRole | 含义 | 前端渲染位置 |
|-------------|------|-------------|
| `"progress"` | 思考过程（工具前的推理） | 可折叠的思考过程区域 |
| `"final"` | 最终回答 | 主要回答区域 |
| `undefined` | 旧数据（向前兼容） | 最后一个 text part = final，其余 = progress |

**角色提升**: 当 LLM 在一轮中不调用工具时，该轮的 text part 从 `"progress"` 提升为 `"final"`：
```typescript
if (result.toolCalls.length === 0) {
  stream.updateTextPartRole(result.textPartId, "final");
}
```

**消息持久化**: `mergeContent()` 只合并 `semanticRole === "final"` 的 text part 到 `content` 字段。

---

## 7. LLM 调用次数对比

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| use_skill (有工具) | 3 次: ①intent_classification ②tool_loop_round1 ③response_composition | 2 次: ①intent_classification(含思考文本) + ②response_composition |
| casual_chat (无工具) | 2 次: ①intent_classification + ②response_composition | 1 次: ①intent_classification(直接输出回答文本) |
