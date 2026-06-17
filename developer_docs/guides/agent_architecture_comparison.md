# SunPilot Agent 架构对比评测

更新时间：2026-06-17
评测对象：SunPilot 当前本地代码实现
参考蓝图：`developer_docs/guides/agent_core_architecture_implementation.md`

## 评测基准

`agent_core_architecture_implementation.md` 描述的目标不是一个“带工具的聊天框”，而是一个可长期演进、可审计、可恢复、可评估的 Agent Core：

```text
用户目标
  -> gateway/session
  -> context/intent/memory
  -> planning/tool routing
  -> permission/approval/sandbox
  -> execution/reflection/replanning
  -> response/memory write
  -> event/state/audit/trace/eval
```

对照 OpenAI Agents SDK、LangGraph、MCP、Anthropic agent engineering/evals 等主流实践，生产级 agent 的优先级通常是：

1. 先把单 Agent loop 做成可测、可审计、可恢复的闭环。
2. 再扩展大工具池治理、MCP metadata 兼容、长期记忆治理。
3. 最后在明确瓶颈出现后再考虑 handoff/multi-agent/workflow DAG。

SunPilot 当前实现整体符合这个顺序：以 local-first 单 Agent runtime 为核心，以 Skill 为工具生态，以 Postgres 承载 run/event/memory/tool/model/trace 数据。

## 本次核对范围

本次基于本地代码重新核对了以下路径：

- Agent service/loop：`packages/core/src/agent/agent.service.ts`、`packages/core/src/agent-kernel/agent-loop-engine.ts`
- 组合根：`packages/daemon/src/composition-root.ts`
- Context/Intent/Planning：`packages/core/src/agent-kernel/context/*`、`intent/*`、`planning/*`
- Tool decision/argument/retrieval/execution：`packages/core/src/agent-kernel/tools/*`、`execution/*`
- Safety：`packages/core/src/agent-kernel/safety/*`
- Memory：`packages/core/src/agent-kernel/memory/*`、`packages/storage/src/repositories/memory.repository.ts`
- Persistence：`packages/storage/src/postgres/*`、`packages/storage/src/repositories/*`、`packages/storage/src/migrations/*`
- Observability：`packages/core/src/agent-kernel/trace-manager.ts`、`trace-persistence.ts`、`packages/api/src/http/register-routes.ts`
- Evals：`evals/agent/*`、根 `package.json` eval scripts
- Web debug/governance UI：`packages/web/src/features/agent-runtime/RunDebugPanel.tsx`、`packages/web/src/pages/SettingsPage/*`

## 总体结论

SunPilot 当前已经进入“单 Agent Core 闭环成型、可观测性与评估闭环补强”的阶段。它不再只是普通聊天机器人，也不只是工具调用 demo，而是具备显式状态机、工具治理、安全边界、持久化事件、长期记忆和调试视图的本地业务 Agent runtime。

当前主链路可以概括为：

```text
Web / REST / WebSocket
  -> AgentService
  -> AgentLoopEngine
  -> ContextBuilder
  -> IntentRouter
  -> RuleBasedPlanner + PlanValidator
  -> ToolDecisionEngine + ToolRetriever + ToolArgumentBuilder
  -> PermissionPolicy + ApprovalGate + ToolSandbox + TaskScopedPermissionManager
  -> ExecutionOrchestrator + SkillToolExecutor
  -> ReflectionEngine + Replanner
  -> ResponseComposer
  -> MemoryWriter
  -> Events + Runs + ToolCalls + ModelCalls + PlanSnapshots + TraceSpans
  -> Debug API / Debug Panel / Golden Tasks
```

和上一版评测相比，当前变化较大：

- `TraceManager` 已有 `RepositoryTraceManager` 包装，并通过 `agent_traces` / `agent_trace_spans` 持久化。
- plan snapshot 已落到 `plan_snapshots`，run 上也有 `active_plan_json` / `plan_revision_count`。
- `ModelRouter` 已成为模型调用记录的统一写入点，`ResponseComposer` 通过 `runId`、`modelCallId`、`metadata.context` 把调用归属和上下文快照交给 Router。
- `GET /v1/runs/:id/trace` 已能合并 run timeline、spans、model calls、tool calls、approvals、plan snapshots。
- Web 侧新增 Run Debug 面板和 Settings/Memory governance UI。
- Golden Task 已有 mock harness 和 opt-in real AgentService harness，根脚本已有 `pnpm eval:agent` 与 `pnpm eval:agent:real`。
- sandbox/permission 全部拒绝时会落 failed `tool_calls`，并以安全 observation 进入 reflection/response 路径，而不是简单内部失败。

因此当前主要短板已经从“模块是否存在”转为：

- 真实 eval 是否稳定纳入 CI 或夜间门禁。
- trace/model/tool/plan evidence 是否足够精确、完整、可回放。
- 安全拒绝、注入、权限变化等异常路径是否可恢复且可解释。
- memory/context trust 与 tool provenance 是否形成结构化质量闭环。
- MCP metadata 兼容是否开始设计，避免未来工具池扩张时返工。

## 与主流 Agent 架构对比

| 维度 | 主流架构趋势 | SunPilot 当前实现 | 评测 |
|---|---|---|---|
| 架构范式 | 单 Agent + tools 先闭环，multi-agent 后置 | 明确采用单 Agent + 多 Skill | 方向正确，复杂度控制合理 |
| Orchestration | 显式状态、checkpoint、human-in-loop、resume | AgentLoopEngine + persisted runs/events/approvals/taskState | 对本地业务 agent 已够用，非通用 DAG |
| Planning | plan validation、replan、evidence、snapshot | Planner/Validator/Replanner 已接入，plan snapshot 已持久化 | 已进入主链路，step evidence 仍可增强 |
| Tool Use | schema、retrieval、guardrails、repair、sandbox | ToolRetriever + argument builder + repair + sandbox + tool metadata | 工具链路强，Top-K/decision audit 仍可更完整 |
| Context | context engineering、压缩、source/trust metadata | safety policy、history、summary、memory、tool result、artifact、trust 字段初步接入 | 可用度高，trust/authority 还未贯穿所有来源 |
| Memory | long-term memory + quality/relation/governance | pgvector/hybrid、relation、quality、supersede/stale API/UI | 底座较强，质量信号对召回排序影响仍有限 |
| Human-in-loop | approval/reject/resume/reauth | DB approval、resumeApprovedTool、continueAfterRejection、scoped permission | 本地体验完整度较高 |
| Guardrails | sandbox、least privilege、prompt injection isolation | ToolSandbox、TaskScopedPermissionManager、PromptInjectionDetector 已接入 | 边界已接入，红队 eval 与拒绝策略还需覆盖更多路径 |
| Observability | trace/model/tool/event/cost 一体化 | events/model_calls/tool_calls/trace spans/plan snapshots + trace API/UI | 已从内存 trace 进入可查询阶段，细粒度关联仍需加强 |
| Evaluation | deterministic golden tasks、real harness、CI gate | mock + real AgentService harness，根 eval scripts 已有 | 框架已成型，真实 harness 稳定性和门禁化是关键 |
| MCP 生态 | dynamic tool/resource/prompt discovery + retrieval funnel | 本地 Skill registry 为主，MCP 仍是 stub/未来兼容 | 未来扩展关键缺口 |
| Multi-Agent | handoff/crew/worker 在必要时引入 | 当前不做 multi-agent | 当前选择合理 |

## 模块评测

### 1. Gateway / Transport

当前实现：

- daemon 提供 REST API 与 WebSocket JSON-RPC。
- `AgentService.handleChatCommand` 统一承接聊天命令并进入 Agent Loop。
- run/conversation/message/clientRequestId 贯穿，idempotency repository 已接入。
- persisted event bus 给外部消费端转发带 DB sequence 的事件。
- REST 已覆盖 conversations、runs、events、status-history、tool-calls、model-calls、context、trace、memory、skills、approvals、artifacts、metrics 等调试与运行接口。

差距：

- Gateway 仍不是独立 policy boundary；团队/SaaS 场景需要 session auth、quota、rate limit、API key 权限域。
- WebSocket/REST 的 agent debug 能力逐步增强，但错误码、权限边界和用户可见失败原因仍可标准化。

结论：本地单用户和开发调试已足够。若后续进入团队部署，Gateway 需要升级为第一层安全、配额和审计边界。

### 2. Agent Loop / State

当前实现：

- 主状态包括 `created -> context_building -> intent_routing -> planning -> tool_deciding -> executing/waiting_approval -> reflecting -> responding -> completed`。
- 支持 cancel、approval resume、approval rejection continue、max tool iterations。
- `taskState` 保存 completed/pending steps、facts、open questions、iteration，并写入 run context。
- `AgentLoopEngine` 已注入 PlanValidator、Replanner、ModelRouter、TraceManager/RepositoryTraceManager、PromptInjectionDetector、ToolSandbox、TaskScopedPermissionManager、PlanSnapshotRepository、ToolCallRepository。
- trace span 启动是 best-effort，不会因为缺 active trace 破坏 run。

差距：

- 仍不是通用 graph runtime，不支持 DAG fork、checkpoint rewind、branch replay。
- run resume 主要覆盖 approval continuation，还不是任意 phase checkpoint resume。
- `ModelRouter` 写 `model_calls` 时持久化失败会计入 `persistFailures`，但还没有统一暴露到 run debug/metrics/事件。

结论：显式状态机适合当前 local business agent。近期不建议改成 LangGraph 式通用 DAG，而应继续增强 run 可回放、失败可解释和审计写入失败可见性。

### 3. Planning / Replanning

当前实现：

- `RuleBasedPlanner` 创建 reasoning/tool/response steps。
- `PlanValidator` 校验 skill availability、依赖、环、风险、输入等，并发出 `agent.plan.validated`。
- `Replanner` 支持 tool failure、goal change、approval rejected、insufficient result、missing parameters、max iterations、safety denied 等触发。
- `agent.plan.created`、`agent.plan.validated`、`agent.plan.revised` 已进入事件流。
- `plan_snapshots` 持久化 created/validated/revised 计划，run 表保存当前 active plan 与 revision count。
- approval resume 会从 snapshot 恢复计划，并延续 revision counter。

差距：

- plan validation error 仍偏“硬失败”，还可以转成 clarification/fallback response。
- step evidence 虽有 `completionEvidence` 和 `planStepId` 方向，但 UI/API 暴露仍偏摘要，未完整支持逐 step evidence 回放。
- plan snapshot version 依赖运行时恢复 latest version，复杂异常恢复场景仍需要更多测试。

结论：Planning 已从“模块存在”升级到“可持久化和可恢复”。下一步应强化 step evidence、plan diff 和 failure-to-replan 的真实 eval。

### 4. Tool System

当前实现：

- Skill capability 使用 `<skill-id>:<capability-name>` 作为工具 ID。
- `ToolDecisionEngine` 支持 plan step、intent candidate、ToolRetriever、deterministic clear winner、LLM semantic selection、reflection priority、clarification。
- `ToolRetriever` 支持 keyword/category/permission/risk/history/embedding 等多层打分，并向 decision metadata 输出 query、topK、candidate scores、fallback 信息。
- `DefaultToolArgumentBuilder` 支持 schema-aware 参数生成、来源记录、历史附件、previous tool result、LLM structured output、缺参澄清和 repair。
- `ExecutionOrchestrator` 负责 tool call 创建、并发分组、retry、schema validation、repair loop、projection hints、metadata 持久化。
- sandbox/permission 拦截发生在 execution 前，并能对全拒绝路径创建 failed tool call 记录。

差距：

- ToolRetriever 的完整候选集、分数解释和 fallback reason 仍主要在 metadata 中，Run Debug UI 只展示部分字段。
- sandbox 位于 loop 层，若未来增加其它工具执行入口，需要保证无法绕过。
- Skill manifest 与 MCP tool metadata 还未完全对齐，例如 output schema、side effects、idempotency、examples、annotations、resource/prompt discovery。

结论：工具参数、repair 和执行链路是当前强项。下一步应把 retrieval/decision metadata 做成可读调试视图，并提前设计 MCP-compatible metadata。

### 5. Context

当前实现：

- `ContextBuilder` 组装 system rules、safety policy、current user message、external attachments、history、conversation summaries、memories、skill catalog、artifacts、tool results、run state。
- `ContextChunk` 已包含 `trust`、`sourceUri`、`generatedAt`、`expiresAt`、`blocked`、`warning`、`authority` 等字段方向。
- attachments/web-like external references 被标为 external/untrusted。
- tool result/artifact/skill catalog/run state 等来源有初步 trust 标记。
- `ResponseComposer` 对 blocked/untrusted/external/failed/timeout/cancelled 工具结果采用不同 prompt 投影策略。
- response model call 通过 `metadata.context` 保存 context snapshot，`GET /v1/runs/:id/context` 和 `GET /v1/model-calls/:id/context` 可查询。

差距：

- trust/source/authority 还没有贯穿所有外部文本来源，例如未来 web fetch、文件解析、MCP resources。
- blocked/untrusted 内容的事实使用边界仍依赖 prompt 约束和局部投影，缺更强的 structured policy enforcement。
- 缺 context eval：长对话压缩后关键约束是否保留、旧 summary 是否覆盖新约束、tool result 指令是否污染系统规则。

结论：Context 已从“拼 prompt”升级为初步 context engineering。下一步要让 trust metadata 进入 eval、response provenance 和 UI debug。

### 6. Memory

当前实现：

- 支持 explicit、intent-based、task summary、conversation summary 等写入。
- `PatternSecretRedactor` 做敏感信息扫描。
- `DefaultMemoryPolicy` 支持 create/supersede/reject/contradiction。
- Memory repository 支持 embedding、relations、quality score、confidence、importance、expires、superseded、soft delete。
- Postgres memory search 已过滤 superseded/soft-deleted 记录，并有 hybrid/pgvector 基础。
- API 新增 `mark-accessed`、`supersede`、`mark-stale`。
- Web Settings 页面提供最小 memory management UI，可筛 active/stale/superseded 并执行 stale/supersede/delete。

差距：

- relation/quality/confidence/recency 对召回排序的影响仍有限，质量信号没有完全转成 recall 行为。
- memory hit/miss、用户纠错反馈、memory provenance 到最终回答的关联仍弱。
- Settings UI 使用 prompt/confirm，适合开发调试，但还不是成熟治理体验。

结论：Memory 底座已经较强，治理入口开始出现。下一步要把质量信号、用户纠错和最终回答 provenance 串起来。

### 7. Safety / Guardrails

当前实现：

- `PermissionPolicy` 支持 ask/auto/full。
- DB approval request/decision/gate 完整，支持 approve/reject/resume。
- `PromptInjectionDetector` 支持多类注入模式和中英文检测，并扫描历史 tool results 与最新 observation summaries。
- `ToolSandbox` 在 loop 执行前校验 filesystem/shell/network。
- `TaskScopedPermissionManager` 支持同 run/同参数授权复用、参数变化重评估、高风险强制重审。
- sandbox/permission 全部拒绝会形成 failed tool call + safety observation，再进入 reflection/response。
- prompt injection blocked 会标记 untrusted/blocked，并发 `agent.safety.injection_detected`。

差距：

- 部分安全拒绝路径仍是“解释/响应”，替代计划和用户可操作 remediation 可以更强。
- 安全拒绝事件与 tool call/result metadata 的展示还不够统一。
- 红队 eval 应覆盖 sandbox denial、prompt injection、permission reauth、用户拒绝审批等真实 AgentService 路径。

结论：安全边界已经接入主链路。下一步应重点做安全拒绝的可恢复体验和真实 eval 覆盖。

### 8. Observability / Debug

当前实现：

- events 表有 sequence，可 replay。
- `model_calls` 记录 provider/model/purpose/token/status/error/metadata，ModelRouter 统一使用 caller-provided `modelCallId`。
- `tool_calls` 保存 arguments/result/status/risk/metadata。
- `run_status_history`、audit、approval、steps、artifacts 均有 repository/migration 支撑。
- `RepositoryTraceManager` 持久化 trace 与 spans。
- `plan_snapshots` 持久化计划版本。
- `GET /v1/runs/:id/trace` 合并 run status timeline、events、spans、model calls、tool calls、approvals、plan snapshots。
- Web `RunDebugPanel` 展示 overview、spans、tools、models、plan；无 active run 时可列历史 run。

差距：

- trace spans 的 `modelCallIds` 关联还不完整，responding/reflection/planning 等 span 多数只记录 count 而不是具体 DB ids。
- `modelCallRecorder.create()` 仍是 best-effort async catch，失败只计入 ModelRouter 内部 `persistFailures`，尚未暴露到 metrics/debug/event。
- Run Debug UI 目前偏工程面板，缺 event payload 展开、context snapshot 快捷入口、plan diff 细节、retrieval Top-K 可视化。

结论：Observability 已经从“数据分散”进入“可查询 debug view”阶段。下一步是把 span-event-model-tool-plan 的双向链接补细，并暴露审计写入失败。

### 9. Evaluation

当前实现：

- `evals/agent` 有 core golden tasks、runner、types。
- 默认 mock harness 用于验证 eval framework。
- `GOLDEN_TASKS_REAL_AGENT=true` 可启用真实 AgentService adapter。
- 根脚本已有：
  - `pnpm eval:agent`
  - `pnpm eval:agent:real`
- Real adapter 使用真实 AgentLoopEngine、ContextBuilder、ToolDecisionEngine、ExecutionOrchestrator、Reflection/Replanner、Safety、Trace 等组件，并配 deterministic fake LLM/skills。

差距：

- 真实 harness 仍是 opt-in，尚未进入 CI 必跑门禁。
- eval report 虽可写入 `evals/reports`，但没有统一 dashboard 或与 run debug 自动链接。
- golden tasks 需要扩展到 trace/plan evidence、sandbox denial、prompt injection、memory contradiction、context retention、tool retrieval ambiguity。

结论：Evaluation 已从“只有 mock”推进到“可跑真实 AgentService”。下一步是稳定化、门禁化和扩大失败路径覆盖。

### 10. MCP / Workflow / Multi-Agent

当前实现：

- 本地 Skill registry 是工具载体。
- `providers/mcp.provider.stub.ts` 仅是未来 MCP bridge 的占位方向。
- 无 MCP client/server adapter。
- 无通用 DAG workflow runtime。
- 无 multi-agent handoff。

评测：

- 暂不做 multi-agent 是正确选择。当前单 Agent 仍有 eval、trace、provenance、memory quality 等硬任务。
- MCP metadata 兼容应提前设计，因为 ToolRetriever 已经具备大工具池召回基础。

结论：近期优先 MCP tool metadata 对齐和 ToolRetriever mandatory funnel，不优先 multi-agent。

## 成熟度评分

| 模块 | 分数 | 说明 |
|---|---:|---|
| Agent Loop / State | 8 | 主链路完整，状态持久化和 approval resume 较成熟；任意 checkpoint resume 仍弱 |
| Gateway / Transport | 7 | 本地 runtime 足够，团队级 auth/quota/rate limit 不足 |
| Planning / Replanning | 8 | validator/replanner/snapshot 已接入；step evidence 和 plan diff 展示仍需增强 |
| Tool Decision / Execution | 8 | retrieval/argument/repair/sandbox 链路强；Top-K/decision UI 和 MCP metadata 仍待补 |
| Context | 8 | 预算、summary、memory、trust、snapshot 都有；context eval 和 trust enforcement 仍弱 |
| Memory | 7 | pgvector/relation/quality/governance API/UI 已有；质量信号对召回影响仍有限 |
| Safety / Guardrails | 8 | injection/sandbox/scoped permission/approval 已接主链路；红队 eval 和 remediation 仍需补 |
| Observability / Debug | 7 | trace/model/tool/plan API 和 UI 已成型；跨对象关联和审计失败暴露不足 |
| Evaluation | 6 | mock + real AgentService harness 和脚本已有；CI/夜间门禁和报告体系未完善 |
| MCP / Tool Ecosystem | 4 | 本地 Skill 可用，MCP adapter 未实现 |
| Workflow / Multi-Agent | 3 | 当前刻意不做；对近期目标不是问题 |

## 当前高价值风险

1. **审计链路仍有 best-effort 缺口**
   ModelRouter 统一写 `model_calls` 是正确方向，但持久化失败目前主要计入内部 `persistFailures`。如果 DB 异常，debug/metrics 可能缺模型调用记录。建议将 persist failure 暴露到 trace span metadata、metrics 或 `agent.error`。

2. **trace span 与具体 model/tool/event 的精确链接不足**
   API 能返回 spans、modelCalls、toolCalls，但 span metadata 中的 `modelCallIds/toolCallIds/eventSequences` 还不完整。异常排查时仍需要人工按时间线拼。

3. **真实 eval 还未成为工程门禁**
   `pnpm eval:agent:real` 已存在，但 real harness 尚未进入 CI/nightly gate，也没有固定报告归档策略。

4. **Run Debug UI 可用但还偏浅**
   已有 overview/spans/tools/models/plan，但缺 event payload 展开、context snapshot 快捷入口、retrieval candidate Top-K、plan diff 细节。

5. **Memory quality 还没有完全进入 recall 行为**
   stale/supersede API 和 UI 已有，但 quality/confidence/recency/relation 对排序和回答 provenance 的影响仍需闭环。

## 推荐定位

SunPilot 当前最适合继续定位为：

```text
Local-first business agent runtime
Single Agent core
Skill-first tool ecosystem
Postgres-backed state/memory/event/trace store
Deterministic eval harness for regression control
MCP-compatible tool metadata in the next stage
```

不建议近期做：

- 改造成通用 DAG/workflow runtime。
- 优先引入 multi-agent/handoff。
- 把所有工具直接暴露给模型。
- 在 trace/eval/provenance 未稳定前继续叠复杂 agent 行为。

建议近期做：

1. 将 `pnpm eval:agent` 纳入常规 CI，将 `pnpm eval:agent:real` 作为 nightly 或 release gate。
2. 为 trace span 补 `modelCallIds`、`toolCallIds`、`eventSequences`，让 debug view 可以跨对象跳转。
3. 暴露 ModelRouter `persistFailures` 到 metrics/debug/event。
4. 扩展 Run Debug UI：event payload、context snapshot、retrieval Top-K、plan diff。
5. 让 memory quality/confidence/recency/relation 真正影响 recall ranking，并在回答 provenance 中可见。
6. 设计 Skill manifest 与 MCP tool metadata 的兼容层，保证未来 MCP tools 仍必须经过 ToolRetriever/permission/sandbox/trace/eval。
