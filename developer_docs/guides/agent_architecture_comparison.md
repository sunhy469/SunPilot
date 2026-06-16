# SunPilot Agent 架构对比评测

更新时间：2026-06-16
评测对象：SunPilot 本地实现代码
参考蓝图：`developer_docs/guides/agent_core_architecture_implementation.md`

## 参考基准

`agent_core_architecture_implementation.md` 给出的目标不是“聊天 prompt”，而是一个可持续运行的 Agent Core：

```text
用户目标
  -> gateway/session
  -> intent/context/memory
  -> planning/tool routing
  -> permission/approval/sandbox
  -> execution/reflection/replanning
  -> response/memory write
  -> event/state/audit/trace/eval
```

对照 OpenAI Agents SDK、LangGraph、MCP、Anthropic agent engineering/evals 等主流实践，生产级 agent 的关键不是先做 multi-agent，而是先让单 Agent 具备可恢复状态、工具治理、上下文可信度、安全边界、可观测性和回归评估。

## 本地实现依据

本次重新核对了以下代码路径：

- Agent service/loop：`packages/core/src/agent/agent.service.ts`、`packages/core/src/agent-kernel/agent-loop-engine.ts`
- 组合根：`packages/daemon/src/composition-root.ts`
- Context/Intent/Planning：`packages/core/src/agent-kernel/context/*`、`intent/*`、`planning/*`
- Tool decision/argument/retrieval/execution：`packages/core/src/agent-kernel/tools/*`、`execution/*`
- Safety：`packages/core/src/agent-kernel/safety/*`
- Memory：`packages/core/src/agent-kernel/memory/*`
- Persistence：`packages/core/src/agent-kernel/persistence/*`、`packages/storage/src/postgres/*`、`packages/storage/src/migrations/*`
- Observability/evals：`packages/core/src/agent-kernel/trace-manager.ts`、`evals/agent/*`
- Protocol/UI events：`packages/protocol/src/agent-events.ts`、`packages/web/src/features/chat/types.ts`

## 总体结论

SunPilot 当前已经是一个较完整的 local-first 单 Agent runtime，而不是普通聊天机器人：

```text
WebSocket/REST
  -> AgentService
  -> AgentLoopEngine
  -> ContextBuilder
  -> IntentRouter
  -> RuleBasedPlanner + PlanValidator
  -> ToolDecisionEngine + ToolRetriever + ToolArgumentBuilder
  -> PermissionPolicy + Approval + Sandbox + scoped permission
  -> ExecutionOrchestrator + SkillToolExecutor
  -> ReflectionEngine + Replanner
  -> ResponseComposer
  -> MemoryWriter
  -> Events + State + Persistence + Trace
```

和旧评测相比，几个原本“未接入”的模块已经进入主链路：

- `PlanValidator`、`Replanner` 已在 `composition-root.ts` 实例化并注入 `AgentLoopEngine`。
- `ToolRetriever` 已注入 `ToolDecisionEngine`，用于工具 Top-K 召回和重排。
- `ModelRouter` 已通过 purpose-specific `LlmProvider` adapter 接入 intent、tool argument、planning、reflection、response、replanning。
- `PromptInjectionDetector` 已扫描历史 tool results 与最新 observation tool summaries。
- `ToolSandbox` 与 `TaskScopedPermissionManager` 已在 `AgentLoopEngine.handleUseTool` 执行前参与校验。
- `TraceManager` 已注入 loop，并覆盖 context、intent、tool execution、reflection、response 等核心 span。

因此当前主要问题已经从“模块缺失”变为“接入质量、持久化程度、事件/trace/eval 闭环和真实验收不足”。

## 与主流 Agent 架构对比

| 维度 | 主流架构趋势 | SunPilot 当前状态 | 评测 |
|---|---|---|---|
| 架构范式 | 先单 Agent + tools，复杂任务再引入 handoff/multi-agent | 明确采用单 Agent + 多 Skill | 方向正确，复杂度控制合理 |
| Orchestration | graph/state/checkpoint/resume/human-in-loop | 显式状态机 + persisted runs/events/approvals | 对本地业务 agent 足够，DAG workflow 较弱 |
| Planning | plan validation、replan、step evidence | RuleBasedPlanner + PlanValidator + Replanner 已接入 | 已进入主链路，但 plan 持久化和恢复仍弱 |
| Tool Use | schema、retrieval、guardrails、repair、sandbox | ToolRetriever + argument builder + repair + sandbox | 工具参数链路强，metadata/eval 仍需补 |
| Context | context engineering、压缩、来源可信度 | TokenBudgeter、summary、memories、tool results、artifacts | 可用度高，缺统一 trust/untrusted 数据模型 |
| Memory | short-term state + long-term vector/relational memory | pgvector/hybrid search、relation、quality、summary memory | 基础较强，召回质量反馈和治理 UI 不足 |
| Human-in-loop | approval/interrupt/resume/reject strategy | DB approval、resumeApprovedTool、continueAfterRejection | 本地体验较完整 |
| Guardrails | policy、injection isolation、sandbox、least privilege | injection/sandbox/scoped permission 已接入 | 已有边界，但拒绝路径和安全事件还粗 |
| Observability | trace/model/tool/event/cost/eval 一体化 | events/model_calls/tool_calls + in-memory TraceManager | 数据多但未形成可查询 trace/eval 飞轮 |
| Evaluation | golden tasks、deterministic harness、CI gate | `evals/agent` 有任务和 runner，但测试仍是 mock executor | 最大可靠性缺口 |
| MCP 生态 | 动态工具/资源/prompt discovery，工具池检索 | Skill 是本地工具载体，未实现 MCP client/server | 未来扩展关键缺口 |
| Multi-Agent | handoff/crew/worker 只在必要时引入 | 暂不做 multi-agent | 当前选择合理 |

## 模块评测

### 1. Gateway / Transport

当前实现：

- WebSocket JSON-RPC 与 REST API 由 daemon 层提供。
- run/conversation/message 贯穿，`clientRequestId` 走 idempotency repository。
- persisted event bus 会给外部消费端转发带 DB sequence 的事件。
- Origin 检查、idle timeout、recover/replay 基础存在。

差距：

- Gateway 仍不是独立 policy boundary；多租户 auth、quota、rate limit、API key/session permission 还没有系统化。
- 本地单用户足够，团队/SaaS 模式不足。

结论：当前适合 local-first runtime。若产品形态走团队协作，Gateway 必须升级为第一层安全与配额边界。

### 2. Agent Loop / State

当前实现：

- 主状态包括 `created -> context_building -> intent_routing -> planning -> tool_deciding -> executing/waiting_approval -> reflecting -> responding -> completed`。
- 支持 cancel、approval resume、approval rejection continue、max tool iterations。
- `taskState` 会保存 completed/pending steps、facts、open questions、iteration，并写入 run context。
- events 表有 sequence，可支持 replay。

差距：

- plan 对象本身没有作为一等实体持久化；恢复时主要依赖 run context/taskState，而不是 checkpointed plan graph。
- `TraceManager` 是内存态，不随 run 持久化。
- 不支持 LangGraph 式 DAG/fork/checkpoint rewind。

结论：显式状态机适合当前对话式业务 agent。近期不应改造成通用 graph runtime，应该先把 plan/task evidence、trace 和 eval 做实。

### 3. Planning / Replanning

当前实现：

- `RuleBasedPlanner` 创建 tool/reasoning/response steps。
- `PlanValidator` 校验 skill availability、依赖、环、风险、输入等；error 会阻断执行并发 `PLAN_VALIDATION_FAILED`。
- `Replanner` 能基于 tool failure、goal change、approval rejection、insufficient result、missing parameters、max iterations 等触发改 plan。
- `agent.plan.created`、`agent.plan.warnings`、`agent.plan.validated`、`agent.plan.revised` 已进入协议事件。
- plan step status 已扩展到 `pending/in_progress/completed/verified/blocked/skipped/waiting_approval/failed_retryable/failed_terminal` 等，并支持 `completionEvidence`。

差距：

- plan validation error 当前直接使 run failed，尚未优雅转成 clarification/fallback response。
- revised plan 没有持久化为可回放版本历史。
- step 与 toolCall 的匹配主要按 `skillId`，同一 skill 多次出现时证据绑定可能不稳定。

结论：Planning 已从“补模块”进入“补恢复语义和证据精度”阶段。

### 4. Tool System

当前实现：

- Skill capability 使用 `<skill-id>:<capability-name>` 作为工具 ID。
- `ToolDecisionEngine` 优先处理 reflection priority、plan tool steps、no_tool、intent candidate、ToolRetriever、deterministic clear winner、LLM semantic selection、fallback。
- `ToolRetriever` 支持 keyword/category/permission/risk/embedding/history 等多层打分。
- `DefaultToolArgumentBuilder` 支持 schema-aware 参数生成、来源记录、历史附件、previous tool result、LLM structured output、缺参澄清。
- `ExecutionOrchestrator` 负责并发分组、retry、schema validation、repair loop、tool call metadata。
- `SkillToolExecutor` 统一执行 skill 并收集 artifact。

差距：

- tool selection 的 Top-K 分数、match reasons、fallbackUsed 未系统写入事件或 tool call metadata。
- `SkillToolExecutor` 自身不持有 sandbox，sandbox 在 loop 执行前做；若未来有其它执行入口，容易绕过。
- Skill manifest 与 MCP tool metadata 还未完全对齐，例如 output schema、side effects、idempotency、examples、annotations。

结论：参数生成和 repair 是当前强项。下一步要让工具选择、执行边界和结果 provenance 更可审计。

### 5. Context

当前实现：

- `ContextBuilder` 组装 system rules、safety policy、current message、history、conversation summaries、memories、skill catalog、artifacts、tool results。
- `TokenBudgeter` 负责按优先级裁剪。
- conversation summary 支持 messageRange、stale detection。
- tool results 和 latest observation 已有 injection scan。
- response metadata 保存 toolCall/candidate provenance。

差距：

- 不可信内容缺统一数据结构；当前更多是 content 被改写或 warning 被前置。
- attachment parsed content、web content、tool result、external memory 的 trust/source/authority 还没有贯穿所有模块。
- 缺 context eval：裁剪/总结后关键约束是否仍在。

结论：Context 可用度高，但安全与质量要从“文本提示”升级为结构化 metadata 流转。

### 6. Memory

当前实现：

- 支持 explicit、intent-based、task summary、conversation summary 等写入。
- `PatternSecretRedactor` 做敏感信息扫描。
- `DefaultMemoryPolicy` 支持 create/supersede/reject/contradiction。
- Memory repository 支持 embedding、relations、quality score，Postgres/pgvector migration 已有 HNSW index。
- 用户、系统、助手消息保存路径会尽量生成 embedding。

差距：

- relation/quality 还没有明显影响召回排序和冲突降权。
- 缺 memory hit/miss 反馈、冲突解决 UI、用户可控治理流程。
- embedding fallback reason/model/dimension metadata 仍可更系统。

结论：Memory 底座已经不错。下一步是把质量信号变成召回行为和用户可见治理。

### 7. Safety / Guardrails

当前实现：

- `PermissionPolicy` 支持 ask/auto/full。
- DB approval request/decision/gate 完整。
- `PromptInjectionDetector` 支持多类注入模式和中英文检测，并已接入 context tool results 与最新 observation summaries。
- `ToolSandbox` 已在 loop 执行前校验 filesystem/shell/network。
- `TaskScopedPermissionManager` 已参与同 run/同参数授权复用与高风险强制重审。

差距：

- sandbox 拒绝目前多为抛错后 run failed，未统一转成 tool call `SANDBOX_DENIED`、reflection/replan 或用户可操作说明。
- 注入事件目前复用 `agent.error`，没有独立 `agent.safety.*` 协议事件。
- 安全测试仍没有真实 agent harness。

结论：安全边界已经接入，但拒绝路径、事件语义和红队 eval 还需要产品化。

### 8. Observability / Evaluation

当前实现：

- agent event 类型较完整，events 表有 sequence。
- `model_calls` 记录 provider/model/purpose/token/status/metadata/context snapshot。
- `tool_calls` 有 metadata，可存 argument source 与 repair history。
- `run_status_history`、audit、approval、steps、artifacts 均有 repository/migration 支撑。
- `TraceManager` 已产生内存 trace/span 和 aggregate metrics。
- `evals/agent` 已有 7 个 core golden tasks、runner 和类型。

差距：

- `TraceManager` 未持久化，也没有 API/UI viewer。
- ModelRouter 自己的 purpose stats 与 `model_calls` repository 不是同一条记录链；多数模块的 LLM 调用仍未全部落 DB model_calls。
- Golden Task 测试当前使用 mock executor，明确“validate eval harness, not agent behavior”，不能证明真实 AgentService 行为。
- 根 `package.json` 没有 `eval:agent` 脚本。

结论：可靠性最大短板是 eval 和 trace 没有闭环。当前数据底座足够，缺的是真实 harness 和可查询视图。

### 9. MCP / Workflow / Multi-Agent

当前实现：

- 本地 Skill registry 是工具载体。
- 无 MCP client/server adapter。
- 无通用 DAG workflow runtime。
- 无 multi-agent handoff。

评测：

- 不做 multi-agent 是正确选择；当前单 Agent 仍有 eval、安全、trace、tool provenance 的硬缺口。
- MCP 兼容值得提前设计，因为 ToolRetriever 已经具备工具池扩展的基础。

结论：近期优先 MCP metadata 兼容层，不优先 multi-agent。

## 成熟度评分

| 模块 | 分数 | 说明 |
|---|---:|---|
| Agent Loop / State | 8 | 主链路完整，恢复语义仍需加强 |
| Gateway / Transport | 7 | 本地充分，团队/SaaS 边界不足 |
| Context | 8 | 预算、summary、memory、tool results 都有，trust metadata 不足 |
| Memory | 7 | pgvector/relation/quality 已有，治理闭环不足 |
| Tool Decision / Argument | 8 | 参数和 repair 强，selection metadata 不足 |
| Planning / Replanning | 7 | 已接入，持久化和证据精度不足 |
| Safety / Guardrails | 7 | 已接入，拒绝路径和安全 eval 不足 |
| Observability | 6 | 数据多，trace 未持久化，viewer 缺失 |
| Evaluation | 4 | golden tasks 有框架，但真实 AgentService harness 缺失 |
| MCP / Tool Ecosystem | 4 | Skill 本地可用，MCP 未接 |
| Workflow / Multi-Agent | 3 | 当前刻意不做，不影响近期目标 |

## 推荐定位

SunPilot 最适合继续定位为：

```text
Local-first business agent runtime
Single Agent core
Skill-first tool ecosystem
Postgres-backed state/memory/event store
MCP-compatible in the future
```

不建议近期做：

- 改造成 LangGraph 式通用 DAG runtime。
- 优先引入 multi-agent/handoff。
- 把所有工具一次性暴露给模型。
- 在没有真实 Golden Task harness 前继续堆 agent 行为复杂度。

建议近期做：

- 把 Golden Tasks 接到真实 `AgentService`。
- 持久化 trace/plan/replan/evidence，让 run 可以被审计和回放。
- 把 sandbox/injection denial 变成可恢复、可解释的 tool observation。
- 将 ToolRetriever/ModelRouter 的决策记录统一写入 metadata。
- 设计 Skill manifest 与 MCP tool metadata 的兼容层。

下一步完善清单见：`developer_docs/guides/agent_architecture_next_steps.md`。
