# SunPilot 主流 ReAct Agent Loop 大范围重构方案

## 1. 文档目的

本文定义 SunPilot Agent Loop 从当前“预推理 + 意图路由 + 工具选择器 + 局部 Native Tool Loop”的混合架构，重构为主流 ReAct（Reasoning and Acting）范式的目标架构、接口边界、状态模型、迁移步骤和验收标准。

本文是后续代码重构的实施规格，不是概念介绍。后续实现应以本文定义的职责边界和删除清单为准，不再继续扩展当前多层语义路由链路。

本次重构的核心目标是：

> 对每一次用户请求，LLM 必须在完整上下文和候选工具定义之上产生第一次 Action；每次环境返回 Observation 后，必须再次由 LLM 决定下一步，直到 LLM 结束、请求用户输入、等待审批或运行失败。

---

## 2. 当前架构问题

### 2.1 当前真实主路径

当前代码的主要执行路径是：

```text
用户消息
  ↓
PreliminaryInferenceService
  ├─ 输出用户可见 progress 文本
  ├─ 生成 intentType
  └─ 生成 toolHints
  ↓
ContextBuilder
  ↓
IntentRouter
  ↓
Planner（条件执行）
  ↓
ToolSelector.decide()
  ├─ no_tool
  ├─ ask_clarification
  ├─ require_approval
  └─ use_tool + PlannedToolCall[]
  ↓
NativeToolLoopExecutor
  ├─ 可能跳过首轮 LLM
  ├─ 可能构造 synthetic tool call
  └─ 工具结果后再调用 LLM
  ↓
ResponseComposer 或工具循环最终文本
```

相关实现主要分布在：

- `packages/core/src/agent-kernel/agent-loop-engine.ts`
- `packages/core/src/agent-kernel/agent-loop-engine/preliminary-inference.ts`
- `packages/core/src/agent-kernel/agent-loop-engine/run-preparation.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/tool-selector.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/native-tool-loop-executor.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/streaming-tool-call-executor.ts`
- `packages/core/src/agent-kernel/response/response-composer.ts`

### 2.2 决策权分裂

当前至少有四个组件参与语义决策：

1. `PreliminaryInferenceService` 判断意图并映射工具。
2. `IntentRouter` 再次判断意图和候选技能。
3. `ToolSelector` 决定是否调用工具、调用哪个工具以及是否澄清。
4. `NativeToolLoopExecutor` 中的 LLM 再决定是否产生 native tool call。

这导致系统没有单一的 Next Action 权威来源。同一请求可能因为模型延迟、阈值、检索分数或前置规则命中情况不同而走不同执行路径。

### 2.3 200ms race 使行为依赖延迟

当前 `AgentLoopEngine` 最多等待预推理 200ms：

```typescript
const preliminary = await racePreliminaryWithTimeout(
  preliminaryPromise,
  200,
);
```

预推理结果又会影响工具提示和首轮 LLM 是否跳过。因此当前语义实际上是：

```text
预推理在 200ms 内完成  → 使用结果改变执行路径
预推理超过 200ms       → 忽略结果走另一条路径
```

这不是合理的超时容错，而是用响应速度决定业务行为。并且 race 超时不会取消原 Promise，迟到的预推理仍可能向消息流写入 progress 内容。

目标架构必须完全删除该竞速机制。

### 2.4 `skipFirstLlmTurn` 破坏 ReAct 的第一次 Action

当前路径可能根据预推理文本和 ToolSelector 结果跳过 Native Tool Loop 的第一次 LLM 调用，并构造：

```typescript
{
  type: "function",
  function: {
    name: functionName,
    arguments: "{}",
  },
}
```

这相当于由前置算法替 LLM 产生 Action，然后直接执行工具。即使后续存在 Observation → LLM，也不能称为完整 ReAct，因为第一次 Action 不是由统一的 ReAct 模型回合产生的。

目标架构必须删除：

- `skipFirstLlmTurn`
- synthetic tool call
- 空参数 Action
- 依据 progress 文本决定是否执行工具的逻辑

### 2.5 ToolSelector 不是安全门，而是第二个 Agent

现有注释将 `ToolSelector.decide()` 描述为安全门，但它实际上会：

- 读取意图和计划；
- 运行工具检索和打分；
- 使用 LLM 进行语义重排；
- 选择具体 Skill；
- 调用 `ToolArgumentBuilder` 构造参数；
- 返回 `no_tool`、`ask_clarification` 或 `use_tool`。

安全门只能验证或拒绝已经产生的 Action，不能替模型选择 Action。目标架构中，工具检索与工具决策必须拆开：

```text
Tool Retriever：提供候选能力
LLM：选择 Action
Tool Guard：校验和约束 Action
```

### 2.6 结构错误被硬停止，没有形成 Observation

当前缺少参数、权限拒绝等情况可能直接返回 `stop`，随后由代码拼出固定文本并结束循环。

主流 ReAct 中，这些都属于环境 Observation：

```text
LLM ToolCall
  ↓
参数校验失败
  ↓
ToolErrorObservation
  ↓
LLM 决定修复参数、换工具、询问用户或结束
```

只有取消、全局 deadline、不可恢复的基础设施故障等情况才应由运行时直接终止。

### 2.7 工具结果可以绕过 LLM 直接成为最终回答

当前 `outputIsFinal` projection 可以把工具结果直接写入 final part，并跳过后续 LLM。

严格 ReAct 主路径中，每个 ToolResult 都必须先成为 Observation，再由 LLM 决定是否结束。否则工具元数据又获得了最终回答决策权。

如果业务要求工具输出逐字保留，应通过 Observation 投影和输出约束保证内容不被改写，而不是绕开 LLM 状态转换。

### 2.8 审批恢复不是 ReAct 恢复

当前审批通过后会确定性执行已批准工具，然后使用独立 `ResponseComposer` 生成说明；审批拒绝后则写入固定模板文本。

正确语义应是：

```text
审批通过
  ↓
执行冻结的 ToolCall
  ↓
ToolObservation
  ↓
恢复同一个 ReAct transcript
  ↓
LLM 决定下一步
```

```text
审批拒绝
  ↓
ApprovalRejectedObservation
  ↓
恢复同一个 ReAct transcript
  ↓
LLM 决定换方案、解释或结束
```

审批恢复不能重新让模型猜测已批准的工具，也不能直接跳到独立回答器。

---

## 3. 目标架构原则

### 3.1 单一语义决策者

每一轮只有 ReAct LLM 可以产生语义 Action：

- 最终回答；
- 调用一个或多个工具；
- 请求用户补充信息；
- 在工具 Observation 后继续调用其他工具；
- 在错误 Observation 后重试、换工具或结束。

规则、检索器、权限系统和执行器不得替 LLM 选择业务 Action。

### 3.2 代码负责确定性边界

代码负责：

- 构建上下文；
- 检索和裁剪候选工具；
- 校验工具名和 JSON Schema；
- 权限、安全和审批；
- 执行工具；
- 构造可信度明确的 Observation；
- 持久化 checkpoint；
- 管理取消、deadline 和迭代预算；
- 发布事件和维护消息流。

### 3.3 不展示隐藏思维链

ReAct 中的 Reasoning 表示模型在每轮基于上下文决定下一步，不表示必须向用户暴露完整 Chain-of-Thought。

用户可见内容只包括：

- 简短、事实性的 progress；
- 工具调用状态；
- 工具结果摘要；
- 澄清问题；
- 最终回答。

不得要求模型输出“思考文本 + JSON 路由块”，也不得解析自然语言思考来决定执行路径。

### 3.4 生命周期状态与内部阶段分离

当前持久化状态过度描述硬编码阶段：

```text
context_building → intent_routing → planning → tool_deciding
→ executing → observing → reflecting → responding
```

ReAct 是循环，不应被表达成单向流水线。目标持久化状态只描述可恢复生命周期：

```text
created
  ↓
running ←──────────────┐
  ├─ waiting_approval  │
  ├─ waiting_user      │
  ├─ interrupted       │
  ├─ completed         │
  ├─ cancelled         │
  └─ failed            │
                       │
waiting_approval ──────┘
waiting_user ──────────┘
interrupted ───────────┘
```

模型调用、工具执行、Observation 构造等细节通过 span、event 和 checkpoint 记录，不再滥用顶层 run status。

---

## 4. 目标运行流程

```text
用户消息
  ↓
创建 Run、AssistantMessageStream、Trace
  ↓
ContextBuilder.build()
  ├─ 会话历史
  ├─ 当前消息和附件
  ├─ 记忆
  ├─ 已有 artifacts
  └─ 恢复 checkpoint（如有）
  ↓
ToolCatalogRetriever.retrieve()
  ├─ 仅做候选召回和排序
  ├─ 不返回 use_tool/no_tool
  └─ 不构造 ToolCall 参数
  ↓
┌──────────────── ReAct Loop ────────────────┐
│                                            │
│  LLM Turn                                  │
│    ├─ 仅文本且无 tool_calls → Final        │
│    ├─ agent.request_input → Waiting User   │
│    └─ native tool_calls                    │
│             ↓                              │
│  ToolCallGuard                             │
│    ├─ 名称/schema/重复调用校验             │
│    ├─ 权限与安全策略                       │
│    └─ 审批判断                             │
│             ↓                              │
│  ToolExecutor                              │
│             ↓                              │
│  ObservationBuilder                        │
│             ↓                              │
│  追加 transcript 并持久化 checkpoint       │
│             └────────────────────→ LLM Turn│
│                                            │
└────────────────────────────────────────────┘
  ↓
完成消息、写入记忆、结束 Trace 和 Run
```

---

## 5. 核心领域模型

### 5.1 Model Turn

优先使用模型原生 function calling，不再让模型输出自定义“思考 + JSON”。

```typescript
interface ReactModelTurn {
  text: string;
  toolCalls: ToolCall[];
  finishReason:
    | "stop"
    | "tool_calls"
    | "length"
    | "cancelled";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

Action 判定规则：

```text
toolCalls.length > 0             → Tool Action
toolCalls.length === 0 + text    → Final Answer
agent.request_input tool call    → Request User Input
无文本、无工具                   → Model Protocol Error Observation / Retry
```

### 5.2 控制工具

需要暂停运行时，不依赖模型自由文本猜测语义，而是提供运行时内置控制工具：

```typescript
const requestInputTool = {
  name: "agent.request_input",
  description: "Ask the user for information required to continue the task.",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string" },
      missingFields: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
};
```

`agent.request_input` 不进入 SkillRunner，由 Agent Loop 转换为 `waiting_user` checkpoint。

后续如有需要，可以增加 `agent.update_plan`，但规划不是第一阶段必需能力，不应阻塞 ReAct 主路径落地。

### 5.3 Observation

所有环境反馈使用统一结构：

```typescript
type ReactObservation =
  | ToolCompletedObservation
  | ToolFailedObservation
  | ToolValidationObservation
  | PermissionDeniedObservation
  | ApprovalRejectedObservation
  | BudgetObservation;

interface BaseObservation {
  toolCallId?: string;
  kind: string;
  trusted: boolean;
  summary: string;
  modelContent: string;
  metadata?: Record<string, unknown>;
}
```

Observation 必须同时区分：

- `displaySummary`：给用户和 UI 展示；
- `modelContent`：注入下一轮 LLM；
- `trusted`：内容是否来自可信本地执行；
- `structured`：供后续投影和审计使用的结构化结果。

工具输出中的外部文本必须继续标记为不可信输入，不能直接升级为 system instruction。

### 5.4 Checkpoint

每次模型 Action、工具 Observation 和暂停点之后持久化：

```typescript
interface ReactCheckpoint {
  runId: string;
  conversationId: string;
  messageId: string;
  iteration: number;
  transcript: ChatMessage[];
  candidateToolIds: string[];
  pendingToolCalls: PlannedToolCall[];
  artifacts: ArtifactRef[];
  toolCallSummaries: ToolCallSummary[];
  partsSnapshot: AssistantMessagePart[];
  modelId?: "dp" | "seed";
  permissionMode: "ask" | "auto" | "full";
  updatedAt: string;
}
```

审批恢复、用户补充信息恢复和进程中断恢复必须基于 checkpoint，而不是重新运行前置路由来猜测之前的状态。

---

## 6. LLM 调用边界

### 6.1 必须调用 LLM 的位置

1. 完整上下文和候选工具准备完成后的第一次 Action。
2. 每批工具执行产生 Observation 后。
3. 工具参数校验失败后。
4. 工具执行失败后。
5. 审批通过且工具执行完成后。
6. 审批被拒绝后。
7. 用户补充信息并恢复运行后。
8. 达到工具轮次预算后，用禁用工具的最后一轮生成诚实的收尾回答。

### 6.2 不应调用 LLM 的位置

- Run 创建和幂等检查；
- 加载历史、记忆和附件；
- 候选工具权限预过滤；
- JSON 解析和 Schema 校验；
- 权限、安全和审批策略；
- 工具执行；
- 事件发布和持久化；
- 取消和 deadline 判断。

### 6.3 不再存在的 LLM 调用

目标架构删除以下独立语义 LLM 调用：

- Preliminary Inference LLM；
- IntentRouter Layer 2 LLM；
- ToolSelector semantic selection LLM；
- 独立 Reflection LLM；
- 主路径独立 ResponseComposer LLM。

这些职责全部被统一的 ReAct model turn 覆盖。Memory summary、embedding 等非 Action 决策用途的模型调用可以保留，但不得改变当前 ReAct Action。

---

## 7. 候选工具检索

### 7.1 Retriever 只召回，不决策

当前 `ToolRetriever` 依赖 `RoutedIntent` 决定动态 Top-K。目标接口改为：

```typescript
interface ToolCatalogRetriever {
  retrieve(input: {
    query: string;
    context: AgentContext;
    availableTools: ToolDefinitionSource[];
    permissionMode: PermissionMode;
    limit: number;
  }): Promise<{
    tools: RetrievedTool[];
    diagnostics: RetrievalDiagnostics;
  }>;
}
```

检索可以使用：

- 工具名称和描述关键词；
- embedding 相似度；
- 当前附件类型；
- 最近成功或失败记录；
- 权限模式；
- Skill manifest 中的能力和风险元数据。

检索不得返回：

- `use_tool` / `no_tool`；
- `ask_clarification`；
- 最终 `ToolCall`；
- 自动填充后的执行参数。

### 7.2 召回失败策略

召回失败时不能直接推断“不需要工具”。推荐策略：

1. 小工具集：向模型提供全部启用工具。
2. 大工具集：提供安全的 broad fallback 集合并记录 retrieval degraded。
3. 如果没有任何工具：仍调用 LLM，由模型直接回答或说明能力限制。

候选工具数量必须来自配置和上下文预算，不在 Loop 中写死 `3/5/10`。

---

## 8. ToolCall Guard 与执行

### 8.1 Guard 顺序

LLM 产生 native tool call 后，按固定安全顺序处理：

```text
解析工具参数
  ↓
确认工具存在于本轮候选快照
  ↓
JSON Schema 校验
  ↓
规范化参数，但不得覆盖 LLM 已明确给出的合法参数
  ↓
重复调用和循环检测
  ↓
PermissionPolicy
  ↓
ToolSafetyBoundary
  ↓
ApprovalPolicy
  ↓
ExecutionOrchestrator
```

### 8.2 参数修复

不再在 `StreamingToolCallExecutor` 内部偷偷调用另一套参数 LLM 并直接执行修复结果。

首选策略：

1. 确定性规范化，例如字段别名、URL 标准化和附件引用展开。
2. 如果仍不合法，产生 `ToolValidationObservation`。
3. 下一轮 ReAct LLM 根据 schema 和错误信息重新产生 ToolCall。
4. 如果确实需要用户信息，LLM 调用 `agent.request_input`。

这样模型生成的 Action、修复原因和最终执行参数处于同一 transcript 中，可追踪、可恢复。

### 8.3 并行工具调用

当一轮 LLM 返回多个无依赖的 tool calls 时，可以继续使用并行执行，但必须满足：

- 整批调用先完成校验；
- 任意一个调用需要审批时，整批冻结，不执行其他调用；
- 每个结果使用原始 `tool_call_id` 写回；
- Observation 顺序与模型 Action 顺序一致；
- checkpoint 保存完整批次。

---

## 9. 审批、拒绝和恢复

### 9.1 审批前

审批请求创建前必须冻结并持久化：

- 原始模型 transcript；
- 模型产生的完整 ToolCall batch；
- Guard 之后的规范化参数；
- 候选工具快照；
- 当前 iteration；
- 消息 parts snapshot；
- 风险和权限判定证据。

### 9.2 审批通过

审批通过后：

1. 校验批准范围与冻结 ToolCall 完全一致。
2. 不重新调用 LLM 决定该工具。
3. 执行冻结 ToolCall。
4. 构造 ToolObservation。
5. 恢复 checkpoint transcript。
6. 把 ToolCall 和 ToolObservation 追加到 transcript。
7. 再调用 ReAct LLM。

### 9.3 审批拒绝

审批拒绝后不得直接输出固定模板。应追加：

```json
{
  "kind": "approval_rejected",
  "toolCallId": "...",
  "summary": "The user rejected this action.",
  "modelContent": "The proposed tool action was rejected by the user. Do not retry the same action unless the user explicitly changes their decision. Choose a safe alternative or explain that the task cannot continue."
}
```

然后由 ReAct LLM 决定安全替代方案或最终解释。

### 9.4 用户输入恢复

`agent.request_input` 产生 `waiting_user`。用户回复后：

1. 恢复 checkpoint；
2. 追加新的 user message；
3. 重新检索候选工具；
4. 回到 ReAct LLM；
5. 不创建一条脱离原任务的新运行路径。

---

## 10. 流式消息规范

### 10.1 内容块角色

继续使用 `AssistantMessageStream`，但明确角色：

- `progress`：模型调用工具前产生的简短公开说明；
- `status`：工具、审批和恢复状态；
- `tool_use`：模型生成且已通过基础解析的 Action；
- `tool_result`：环境 Observation 摘要；
- `final`：无 tool calls 的最后一个模型回合。

### 10.2 首轮消息

消息卡片可以在上下文构建前创建，但不得在完整上下文完成前启动一个会产生业务 Action 的“预推理文本流”。

上下文准备期间只显示确定性状态：

```text
正在准备上下文…
```

第一段模型文本必须来自正式 ReAct model turn。

### 10.3 文本和 ToolCall 同时出现

如果同一模型回合同时产生文本和 tool calls：

- 文本作为 `progress`；
- tool calls 进入 Guard；
- 后续没有 tool calls 的模型文本才标记为 `final`。

不得把 progress 是否为空作为是否执行工具的判断条件。

---

## 11. 运行预算与终止条件

### 11.1 配置化预算

Loop 内不再写死 `200ms`、`MAX_TOOL_ITERATIONS = 5`、Top-K 等业务常量。统一配置：

```typescript
interface ReactLoopLimits {
  maxToolRounds: number;
  maxModelCalls: number;
  maxWallClockMs: number;
  maxRepeatedToolCalls: number;
  maxObservationTokens: number;
  finalizationReserveTokens: number;
}
```

这些限制用于资源和安全控制，不参与业务语义判断。

### 11.2 正常终止

正常终止只有：

- LLM 返回无 tool calls 的 final text；
- LLM 调用 `agent.request_input`，运行进入 `waiting_user`；
- 工具 Action 进入 `waiting_approval`。

### 11.3 强制终止

强制终止包括：

- 用户取消；
- 全局 deadline；
- 模型连续协议错误超过限制；
- 基础设施不可恢复故障；
- 运行预算耗尽。

工具轮次预算耗尽时，允许一次禁用工具的 finalization LLM turn。系统明确告诉模型不能继续调用工具，要求基于已有 Observation 给出诚实结果。该 finalization turn 不得再次产生工具 Action。

---

## 12. 建议代码结构

```text
packages/core/src/agent-kernel/
  agent-loop-engine.ts                 # 生命周期、checkpoint、暂停与完成
  react-loop/
    react-loop-runner.ts               # Action → Observation 主循环
    react-model-turn.ts                # 单次 native function-calling 调用
    react-types.ts                     # Action/Observation/Checkpoint
    observation-builder.ts             # 执行结果与错误投影
    tool-call-guard.ts                 # schema/permission/safety/approval
    control-tools.ts                   # agent.request_input 等运行时工具
    loop-limits.ts                     # 配置化预算
  tools/
    tool-catalog-retriever.ts          # 候选召回，不做 Action 决策
    tool-definition-builder.ts         # Skill manifest → LLM tools
  persistence/
    react-checkpoint-repository.ts     # checkpoint 持久化
```

`AgentLoopEngine` 保留为 AgentService 的稳定入口，但内部只负责：

```typescript
async run(input, signal) {
  const runtime = await this.createRuntime(input);
  const context = await this.contextBuilder.build(input, signal);
  const tools = await this.toolCatalogRetriever.retrieve({
    query: context.currentMessage.content,
    context,
    availableTools: context.availableSkills,
    permissionMode: input.permissionMode,
    limit: this.limits.toolCatalogLimit,
  });

  return this.reactLoopRunner.run({
    input,
    context,
    tools,
    runtime,
  }, signal);
}
```

### 12.1 ReAct 主循环伪代码

```typescript
async run(scope: ReactRunScope, signal: AbortSignal): Promise<AgentLoopResult> {
  let checkpoint = await this.restoreOrCreateCheckpoint(scope);

  while (true) {
    this.limits.assertWithinBudget(checkpoint);

    const turn = await this.modelTurn.run({
      transcript: checkpoint.transcript,
      tools: checkpoint.candidateTools,
      modelId: scope.input.modelId,
    }, signal);

    checkpoint = await this.recordModelTurn(checkpoint, turn);

    if (turn.toolCalls.length === 0) {
      return this.completeWithFinalText(scope, checkpoint, turn.text);
    }

    const control = this.controlTools.match(turn.toolCalls);
    if (control) {
      return this.suspendForControlAction(scope, checkpoint, control);
    }

    const guarded = await this.toolCallGuard.check({
      calls: turn.toolCalls,
      candidates: checkpoint.candidateTools,
      context: scope.context,
      permissionMode: scope.input.permissionMode,
    }, signal);

    if (guarded.approvalRequired) {
      return this.suspendForApproval(scope, checkpoint, guarded.calls);
    }

    if (guarded.observations.length > 0) {
      checkpoint = await this.appendObservations(
        checkpoint,
        guarded.observations,
      );
      continue;
    }

    const execution = await this.executor.executeBatch(
      guarded.calls,
      signal,
    );

    checkpoint = await this.appendObservations(
      checkpoint,
      this.observationBuilder.fromExecution(execution),
    );
  }
}
```

---

## 13. 现有组件处理决定

| 现有组件 | 决定 | 目标职责或替代物 |
|---|---|---|
| `AgentLoopEngine` | 保留并瘦身 | 生命周期入口，委托 `ReactLoopRunner` |
| `PreliminaryInferenceService` | 删除 | 正式首轮 ReAct model turn |
| `IntentRouter` | 移出主路径 | Retriever 直接基于 query/context 召回 |
| `RuleBasedPlanner` | 移出主路径 | 后续可由 `agent.update_plan` 控制工具替代 |
| `PlanValidator` | 移出主路径 | 仅在显式 plan action 存在时使用 |
| `Replanner` | 删除主路径依赖 | Observation 后的下一轮 LLM 自行调整 |
| `ToolSelector` | 删除 | `ToolCatalogRetriever` |
| `NativeToolLoopExecutor` | 重构并重命名 | `ReactLoopRunner` |
| `StreamingToolCallExecutor` | 拆分 | `ToolCallGuard` + batch executor |
| `ToolArgumentBuilder` | 降级 | 只做确定性规范化；错误回灌 LLM |
| `BasicReflectionEngine` | 删除主路径依赖 | Observation 后的 LLM turn |
| `ResponseComposer` | 删除主路径依赖 | 无 tool calls 的 model turn 即 final |
| `ApprovalFlowCoordinator` | 重写 | checkpoint 驱动的暂停与恢复 |
| `AssistantMessageStream` | 保留 | ReAct 内容块输出 |
| `ExecutionOrchestrator` | 保留 | 纯工具执行和安全边界 |
| `PermissionPolicy` | 保留 | Guard 的确定性策略 |
| `RunStateManager` | 重构状态集 | 生命周期状态，不记录硬流水线阶段 |

---

## 14. 文件级改动清单

### 14.1 删除

- `packages/core/src/agent-kernel/agent-loop-engine/preliminary-inference.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/tool-selector.ts`
- 与 `PreliminaryInferenceResult`、`skipFirstLlmTurn`、`prioritySkills` 前置拍板相关的类型和测试
- `racePreliminaryWithTimeout()`
- `peekResolvedPromise()` 在预推理路径中的用途
- `enablePreliminaryInference`
- synthetic tool call 分支
- 工具结果 `outputIsFinal` 绕过模型的主路径分支

确认无调用方后删除：

- `packages/core/src/agent-kernel/reflection/basic-reflection-engine.ts`
- `packages/core/src/agent-kernel/response/response-composer.ts`
- `packages/core/src/agent-kernel/planning/replanner.ts`
- `packages/core/src/agent-kernel/planning/rule-based-planner.ts`

### 14.2 新增

- `packages/core/src/agent-kernel/react-loop/react-loop-runner.ts`
- `packages/core/src/agent-kernel/react-loop/react-model-turn.ts`
- `packages/core/src/agent-kernel/react-loop/react-types.ts`
- `packages/core/src/agent-kernel/react-loop/tool-call-guard.ts`
- `packages/core/src/agent-kernel/react-loop/observation-builder.ts`
- `packages/core/src/agent-kernel/react-loop/control-tools.ts`
- `packages/core/src/agent-kernel/react-loop/loop-limits.ts`
- `packages/core/src/agent-kernel/persistence/react-checkpoint-repository.ts`

### 14.3 修改

- `packages/core/src/agent-kernel/agent-loop-engine.ts`
- `packages/core/src/agent-kernel/loop-types.ts`
- `packages/core/src/agent-kernel/state/run-state-machine.ts`
- `packages/core/src/agent-kernel/tools/tool-retriever.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/native-tool-loop-executor.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine/streaming-tool-call-executor.ts`
- `packages/core/src/agent-kernel/agent-loop-engine/approval-flow.ts`
- `packages/core/src/agent-kernel/agent-loop-engine/approval-continuation.ts`
- `packages/daemon/src/composition-root.ts`
- `packages/daemon/src/factories/context-factory.ts`
- `packages/daemon/src/factories/tool-factory.ts`
- PostgreSQL run/checkpoint migration和对应 repository

---

## 15. 分阶段实施计划

实施过程不保留长期双主路径。每个阶段允许代码暂时存在尚未删除的旧类，但生产入口始终只有一个；新入口切换后立即删除旧入口，不使用长期 feature flag 维持两套 Agent Loop。

### Phase 0：行为基线和测试夹具

目标：在改动前固定必须保留的外部行为。

新增或确认测试：

- 无工具直接回答；
- 单工具 Action → Observation → Final；
- 多轮工具调用；
- 多工具并行；
- 参数错误回灌；
- 工具失败后换工具；
- 审批通过恢复；
- 审批拒绝恢复；
- 用户补充输入恢复；
- 取消；
- deadline；
- WebSocket replay；
- AssistantMessageStream parts 顺序；
- memory write；
- run recovery。

### Phase 1：建立统一 ReAct Runner

1. 新增 `ReactModelTurn` 和 `ReactLoopRunner`。
2. 从 `NativeToolLoopExecutor` 提取可复用的原生流式模型调用。
3. 首轮必须调用 LLM，不接受 preselected tool IDs。
4. 无 tool calls 时直接完成 final。
5. 有 tool calls 时进入 Guard 和执行。
6. 工具结果一律注入下一轮，不允许 direct final projection。

阶段验收：

- 每个新 Run 的第一条语义 Action 都有 `agent.model.started/completed` 证据；
- 不存在无首轮 LLM 的工具执行；
- no-tool 和 tool 请求使用同一个 Runner。

### Phase 2：收敛候选工具与删除前置决策

1. 将 `ToolRetriever` 改为不依赖 `RoutedIntent`。
2. `AgentLoopEngine` 不再调用 `IntentRouter`、`Planner`、`ToolSelector.decide()`。
3. 删除 PreliminaryInference 和 200ms race。
4. 删除 `skipFirstLlmTurn` 和 synthetic tool call。
5. 从 composition root 移除相关依赖。

阶段验收：

- runtime 路径中只有一次 Action 语义来源；
- 业务 Skill ID 不出现在 Agent Loop 内核；
- 模型延迟不会改变是否使用预推理结果。

### Phase 3：错误 Observation 化

1. 拆分 `StreamingToolCallExecutor` 为 Guard 与 Executor。
2. 参数解析、schema、未知工具、重复调用、权限拒绝都返回结构化 Observation。
3. 删除硬编码 stop 文本。
4. 下一轮 LLM 决定修复、替代、请求用户或结束。

阶段验收：

- 可恢复错误不会由代码直接结束 Run；
- transcript 中可以看到 Action → Error Observation → 新 Action；
- 不会无限重复相同 ToolCall。

### Phase 4：审批和恢复进入同一 transcript

1. 新增持久化 `ReactCheckpoint`。
2. 审批暂停保存完整 transcript 和冻结调用。
3. 审批通过后执行冻结调用并恢复 LLM。
4. 审批拒绝后写入 Observation 并恢复 LLM。
5. 新增 `waiting_user` 和 `agent.request_input`。
6. 中断恢复从 checkpoint 继续，不重新走意图路由。

阶段验收：

- 审批前后保持同一 runId、messageId 和 transcript；
- 批准后不会重新选择已批准工具；
- 拒绝后没有固定模板捷径；
- 恢复后仍可继续调用其他工具。

### Phase 5：状态机、装配和旧代码清理

1. 将持久化状态收敛为生命周期状态。
2. phase 细节迁移到 trace/event。
3. 删除旧 selector、planner、reflection、response 主路径依赖。
4. 删除无调用方类型、配置和测试。
5. 更新 composition root 和开发文档。

阶段验收：

- `rg` 搜索不到 `skipFirstLlmTurn`、`enablePreliminaryInference`、synthetic tool call；
- Agent Loop 主路径不调用 `ToolSelector.decide()`；
- Agent Loop 主路径不调用 `ResponseComposer.composeDirect()`；
- Agent Loop 主路径不调用独立 Reflection；
- 所有 Run 都经过 `ReactLoopRunner`。

---

## 16. 测试策略

### 16.1 单元测试

`ReactModelTurn`：

- 纯文本 final；
- native tool call delta 聚合；
- 文本 + tool call；
- malformed model output；
- abort；
- model failure event。

`ToolCallGuard`：

- 未在候选快照中的工具；
- JSON 解析失败；
- required/anyOf 校验；
- 参数规范化；
- 重复调用；
- permission denied；
- approval required；
- multi-tool batch approval boundary。

`ObservationBuilder`：

- completed/failed/timeout/cancelled；
- structured output；
- artifact 投影；
- 外部内容 trust 标记；
- token 截断。

`ReactLoopRunner`：

- Final；
- Tool → Final；
- Tool A → Tool B → Final；
- Validation Error → repaired Tool → Final；
- Tool Failure → alternative Tool → Final；
- request input；
- approval；
- max rounds finalization；
- cancellation。

### 16.2 集成测试

至少建立以下确定性 scripted-model golden cases：

```text
casual-chat-no-tool
single-tool-success
multi-tool-chain
parallel-tool-batch
missing-params-request-user
invalid-args-self-repair
tool-failure-switch-tool
approval-approve-resume
approval-reject-alternative
cancel-during-model
cancel-during-tool
resume-after-process-restart
```

测试重点不是固定自然语言，而是：

- 每轮 Action 类型；
- tool_call_id 连续性；
- Observation 是否回灌；
- 状态和 checkpoint；
- 事件顺序；
- 是否存在绕过 LLM 的执行。

### 16.3 架构约束测试

建议增加静态约束：

- `AgentLoopEngine` 不得导入 PreliminaryInference、ToolSelector、ResponseComposer 或 ReflectionEngine；
- `react-loop` 不得包含具体业务 Skill ID；
- 工具执行只能从 `ToolCallGuard` 的 validated output 进入；
- `waiting_approval` 必须存在 checkpoint；
- final message 必须关联最后一个无 tool calls 的 model turn，强制终止除外。

---

## 17. 可观测性要求

每轮至少记录：

- `iteration`；
- `modelCallId`；
- 候选工具 ID 和 retrieval score；
- 模型 finish reason；
- tool call 数量；
- Guard 结果；
- approval decision；
- execution latency；
- observation size；
- 累计模型调用和工具轮次；
- checkpoint version。

推荐 span：

```text
agent.run
  ├─ context.build
  ├─ tools.retrieve
  ├─ react.turn[0].model
  ├─ react.turn[0].guard
  ├─ react.turn[0].execute
  ├─ react.turn[0].observe
  ├─ react.turn[1].model
  └─ memory.write
```

不要再用 `pre_inference_await` 或固定流水线 span 表达 ReAct 循环。

---

## 18. 非目标

本次重构不要求同时完成：

- 多 Agent 协作；
- DAG 工作流引擎；
- 自主长期任务调度；
- 完整可视化 Plan 编辑器；
- 暴露模型隐藏 Chain-of-Thought；
- 为旧 Agent Loop 保留长期兼容分支。

这些能力可以建立在统一 ReAct Loop 之上，但不能再次把业务流程硬编码回 Agent Loop 内核。

---

## 19. 最终验收标准

重构完成必须同时满足：

1. 每个用户请求的第一次语义 Action 都由正式 ReAct LLM turn 产生。
2. 每个 ToolResult 都先成为 Observation，再由 LLM 决定下一步。
3. no-tool、tool、错误修复、审批恢复和用户补充都进入同一循环。
4. Agent Loop 内核不包含具体业务 Skill ID。
5. 不存在 200ms 预推理 race。
6. 不存在 `skipFirstLlmTurn`。
7. 不存在 synthetic empty-argument tool call。
8. Tool Retriever 只召回候选，不返回最终执行决定。
9. 权限和审批只约束 Action，不生成业务 Action。
10. 审批通过或拒绝后恢复同一个 transcript。
11. 持久化状态表达生命周期，循环阶段由 checkpoint 和 trace 表达。
12. 所有外部消息仍使用 `agent.message.*` 内容块协议。
13. 取消、恢复、memory write 和 WebSocket replay 不回退。
14. 核心、daemon 构建和相关集成测试全部通过。

满足以上条件后，SunPilot 才可以被称为由单一 LLM Action 决策驱动、具备完整 Action → Observation → Action 闭环的主流 ReAct Agent Loop。
