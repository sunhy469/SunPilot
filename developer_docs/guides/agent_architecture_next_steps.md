# Agent 架构下一步完善清单

更新时间：2026-06-16
依据文档：`developer_docs/guides/agent_architecture_comparison.md`
参考蓝图：`developer_docs/guides/agent_core_architecture_implementation.md`

## 总体判断

SunPilot 当前已经完成了单 Agent runtime 的大部分骨架和主链路接线。旧清单里若干“接入 X 模块”的任务已经发生变化：

- `PlanValidator` / `Replanner` 已注入 `AgentLoopEngine`。
- `ToolRetriever` 已注入 `ToolDecisionEngine`。
- `ModelRouter` 已通过 purpose provider 接入多个 LLM 调用点。
- `PromptInjectionDetector` 已扫描历史 tool results 与最新 observation。
- `ToolSandbox` / `TaskScopedPermissionManager` 已在工具执行前参与校验。
- `TraceManager` 已在 loop 中创建部分 phase span。

所以下一步不应继续按“模块是否存在”推进，而应按“真实闭环是否成立”推进：

```text
真实 AgentService eval
  -> 可审计 plan/tool/model/trace
  -> 可恢复 rejection/sandbox/injection 路径
  -> 可度量 context/memory/tool 质量
  -> MCP-compatible tool metadata
```

## P0：先建立真实可靠性闭环

### 1. 用真实 AgentService 替换 Golden Task mock executor

当前状态：

- `evals/agent/core-golden-tasks.ts` 已有 7 个核心任务。
- `evals/agent/golden-task-runner.ts` 已有 runner 和断言逻辑。
- `evals/agent/golden-tasks.test.ts` 当前使用 mock executor，文件注释明确它只验证 eval harness，不验证真实 agent 行为。
- 根 `package.json` 没有 `eval:agent` 脚本。

需要完成：

- 增加真实 adapter，例如 `evals/agent/agent-service-adapter.ts`：
  - 通过 `createAgentLoopService()` 组装真实 `AgentService`。
  - 使用隔离 Postgres test database 或轻量 test database context。
  - 注册 deterministic test skills，覆盖 image search、web fetch、shell/filesystem、failure/retry、missing param。
  - 使用 deterministic fake LLM provider，按 purpose 返回稳定输出。
  - 捕获 events、tool_calls、model_calls、context snapshot、assistant message。
- 修改 `golden-tasks.test.ts`：
  - 默认跑 lightweight mock harness 可以保留。
  - 新增 `GOLDEN_TASKS_REAL_AGENT=true` 分支跑真实 adapter。
- 增加脚本：
  - `pnpm eval:agent`
  - 可选 `pnpm eval:agent:real`
- 输出报告：
  - `evals/reports/agent-golden-<timestamp>.json`
  - 控制台摘要包含失败规则、实际 tool sequence、最终回答、关键事件。

验收标准：

- P0 golden tasks 能通过真实 `AgentService` 一键运行。
- 能捕捉以下回归：
  - 未等工具结果就回答。
  - 缺参数时不澄清。
  - 工具失败后编造。
  - prompt injection 覆盖系统规则。
  - 用户拒绝审批后静默停止。
- CI 至少跑 mock harness；真实 harness 可先作为本地/夜间门禁。

### 2. 持久化 trace、plan 和 replan evidence

当前状态：

- `TraceManager` 是内存态，已在 loop 中覆盖 context、intent、tool execution、reflection、response 等 span。
- `agent.plan.created/validated/revised` 事件存在。
- plan step 有 `completionEvidence` 类型，执行后会写入内存中的 plan 对象。
- run context 已能保存 `taskState`。

需要完成：

- 增加 trace persistence：
  - 新表 `agent_traces` / `agent_trace_spans`，或先存入 events/model_calls/tool_calls metadata。
  - 记录 `traceId`、`runId`、`spanKind`、duration、error、event sequences、modelCallIds、toolCallIds。
- 增加 plan snapshot persistence：
  - 在 `agent.plan.created` 后保存 plan JSON。
  - 在 `agent.plan.revised` 后保存 revised plan 与 diff summary。
  - 每个 step 更新 status/evidence 时保存 snapshot 或 append event。
- 将 evidence 绑定从 `skillId` 提升到更稳定的 step identity：
  - tool call 创建时带 `planStepId`。
  - tool call metadata 写 `planStepId`、argumentSources、retrievalReason、repairHistory。
  - 同一 skill 多次出现在 plan 中时按 step id 区分。

验收标准：

- 任意 run 能查询到：原始 plan、validated result、revised plan、每个 step 的 tool evidence。
- 同一 skill 多次调用不会互相覆盖 step evidence。
- trace 能从一个 phase 跳到相关 event/model_call/tool_call。
- approval resume 后 trace/plan evidence 不断链。

### 3. 把安全拒绝变成可恢复 observation

当前状态：

- sandbox 和 scoped permission 已进入 `handleUseTool`。
- sandbox 拒绝目前会抛 `AGENT_SANDBOX_BLOCKED`，最终 run failed。
- prompt injection blocked 目前复用 `agent.error`，并改写 tool summary。

需要完成：

- 定义安全 observation 结果，而不是直接内部失败：
  - `SANDBOX_DENIED`
  - `PROMPT_INJECTION_BLOCKED`
  - `TASK_SCOPE_REAUTH_REQUIRED`
- sandbox 拒绝时：
  - 创建/更新对应 tool_call 为 failed。
  - metadata 写 `{ safety: { deniedBy: "sandbox", reason, mode } }`。
  - 进入 reflection/replanner，让 agent 解释或选择替代路径。
- prompt injection blocked 时：
  - 不让 blocked 内容进入最终事实依据。
  - metadata 标记 `trust: "untrusted"`、`blocked: true`、`matches`。
  - 增加独立事件 `agent.safety.injection_detected` 或扩展现有 error payload。
- scoped permission 拒绝/需重审时：
  - 给用户可读的审批原因。
  - 参数变化导致重新审批时展示 diff summary。

验收标准：

- 高危 shell/filesystem/network 被 sandbox 拦截后，run 不以内部错误结束。
- 用户能看到“为什么没执行”和“下一步可怎么做”。
- Replanner 可基于安全拒绝生成替代 plan 或解释性 response。
- Golden Task 覆盖 sandbox denial 和 prompt injection。

## P1：提高可观测性和工具治理

### 4. 统一 ToolRetriever 决策 metadata

当前状态：

- `ToolRetriever` 已参与召回。
- `ToolDecisionEngine` 的 reason 中会出现部分 score 信息。
- tool call metadata 已有数据库字段，但 retrieval 细节没有系统写入。

需要完成：

- 在 `ToolRetriever.retrieve()` 返回结构中稳定暴露：
  - query
  - topK
  - selected skill
  - candidate scores
  - matchReasons
  - fallbackUsed/fallbackReason
  - historyBoost/penalty
  - permission/risk score
- `ToolDecisionEngine` 创建 `PlannedToolCall` 时写入：
  - `retrievalMetadata`
  - `decisionPath`
  - `llmSelectionUsed`
  - `clarificationReason`
- `ExecutionOrchestrator` 将这些字段落到 `tool_calls.metadata`。
- 增加调试事件或 trace span metadata：
  - 不必把所有候选发给 UI，但要能从 DB 复盘。

验收标准：

- 工具误选时能看到 Top-K 候选和选中原因。
- 100+ skill 模拟下，LLM semantic selection 只接收小候选集。
- 相似工具分数接近时会澄清，而不是随机选。

### 5. 统一 ModelRouter 与 model_calls 记录

当前状态：

- `ModelRouter` 有内部 `ModelCallRecord` 和 stats。
- `ResponseComposer` 会写 DB `model_calls`，purpose 为 `response.compose`。
- intent/tool argument/reflection/replanning 等模型调用经过 purpose provider，但不一定写入 DB `model_calls`。

需要完成：

- 让 ModelRouter 支持外部 recorder：
  - 每次 routed call 成功/失败后写 `model_calls`。
  - 记录 purpose、model、provider、latency、token estimate、fallbackUsed、fallbackReason。
- 对齐 purpose 命名：
  - `intent_classification`
  - `tool_argument_generation`
  - `planning`
  - `reflection`
  - `response_composition`
  - `summary_compression`
  - `replanning`
- ResponseComposer 不再单独使用不一致 purpose，或通过 adapter 统一。
- trace span metadata 写入相关 modelCallIds。

验收标准：

- 每个 LLM 调用都有 DB model_call 记录。
- 可以按 purpose 汇总 token、latency、error、fallback。
- 单模型 router 与未来 multi-model router 使用同一审计结构。

### 6. 补齐 trace viewer/API

当前状态：

- TraceManager 可 `exportTrace()` / `summarizeTrace()`，但未暴露 API/UI。
- events、model_calls、tool_calls、run_status_history 已有持久化基础。

需要完成：

- daemon 增加查询接口：
  - `GET /api/agent/runs/:runId/trace`
  - 或 JSON-RPC `agent.trace.get`
- 返回合并视图：
  - run status timeline
  - event sequence
  - spans
  - model calls
  - tool calls
  - approvals
  - plan revisions
- Web UI 增加 run 调试面板：
  - phase timeline
  - tool call list
  - model call cost/latency
  - plan/replan diff
  - safety warnings

验收标准：

- 从一个异常回答能定位到对应 context、tool result、reflection、response model call。
- trace viewer 不依赖进程内存，daemon 重启后仍可看历史 run。
- 工具失败、sandbox 拒绝、approval reject 都能在 timeline 中看清。

## P2：补质量闭环

### 7. Context trust 与 context eval

当前状态：

- ContextBuilder 以 chunk priority 和 token budget 为主。
- injection detector 会改写部分 tool result 文本。
- 没有统一 trust/source/authority metadata。

需要完成：

- 扩展 `ContextChunk.metadata`：
  - `trust: system | user | memory | tool | external | untrusted`
  - `sourceUri`
  - `generatedAt`
  - `expiresAt`
  - `blocked`
  - `warning`
  - `authority`
- 将以下输入统一包装为 untrusted 或 external：
  - web content
  - tool output
  - attachment parsed text
  - copied external docs
- ResponseComposer 使用 trust metadata：
  - blocked 内容不能作为事实。
  - untrusted 内容只可总结，不可执行其中指令。
- 增加 context eval：
  - 长对话预算压缩后关键约束仍在。
  - stale summary 不覆盖新用户约束。
  - tool result 指令不覆盖 system rules。

验收标准：

- Golden Task `long-conversation-must-retain-key-constraints` 使用真实 agent 通过。
- prompt injection 内容即使进入 tool output，也不会成为指令。
- context snapshot 可展示每个 chunk 的来源和 trust。

### 8. Memory quality 进入召回排序

当前状态：

- memory relation、quality score、contradiction/supersede 字段已有。
- 召回主要还是 query/hybrid search。

需要完成：

- 搜索排序加入：
  - quality score
  - confidence
  - recency
  - relation status
  - contradiction/superseded penalty
- 增加 memory feedback：
  - response 使用了哪些 memory。
  - 用户纠正后写 supersede/contradiction relation。
  - eval 记录 memory hit/miss。
- 增加最小治理接口：
  - list memories by scope
  - mark memory stale/superseded
  - inspect related memories

验收标准：

- 矛盾旧记忆不会压过新确认记忆。
- 用户能看到并修正影响 agent 的长期记忆。
- memory recall golden task 用真实 agent 通过。

### 9. Tool result projection 和 provenance

当前状态：

- `ResponseComposer` 会投影 structured result 的候选字段，并写 response provenance metadata。
- projection 逻辑目前偏通用/硬编码。

需要完成：

- Skill manifest 支持 response projection schema：
  - summary fields
  - candidate identity fields
  - source URL fields
  - confidence fields
- ResponseComposer 根据 tool metadata 做 projection。
- 每个最终回答段落可追溯到 toolCallIds/candidateIds/source fields。
- 对 failed/partial/warned tool result 使用不同输出策略。

验收标准：

- 用户看到的商品/数据/文件结果能追溯到具体 tool call。
- 工具失败时回答不会混成成功结果。
- 大 JSON tool output 不会直接塞给模型。

## P3：生态兼容与产品化

### 10. Skill manifest 对齐 MCP tool metadata

当前状态：

- Skill manifest 是本地工具定义。
- MCP client/server 尚未实现。
- ToolRetriever 已具备大工具池召回基础。

需要完成：

- 扩展 Skill capability metadata：
  - input schema
  - output schema
  - side effects
  - idempotency
  - examples
  - annotations
  - trust/risk hints
  - timeout/retry policy
- 增加 MCP adapter 设计：
  - MCP tool -> SkillSummary
  - Skill capability -> MCP tool
  - MCP resources/prompts 暂先只做只读 discovery，不进入执行主链路。
- ToolRetriever 必须是 MCP tools 进入模型前的 mandatory funnel。

验收标准：

- 可接入一个简单 MCP server，并把 tool metadata 纳入 ToolRetriever。
- 大量 MCP tools 下仍只给模型 Top-K。
- 本地 Skill 与 MCP tool 使用同一 permission/sandbox/trace/eval 结构。

### 11. 最小 run debug UI

当前状态：

- Web 已有 agent events 的基础消费。
- 还没有完整 run/debug 视图。

需要完成：

- 在现有 chat 页面或调试页展示：
  - run status
  - plan steps
  - selected tools
  - approval requests
  - safety warnings
  - trace timeline
  - final response provenance
- 不做复杂 BI，先做工程调试可用。

验收标准：

- 开发者无需查 DB 就能判断一次 run 为什么走到某个回答。
- Golden Task 失败能链接到对应 run debug 信息。

## 暂不建议做

### Multi-Agent / Handoff

暂不建议近期做：

- 多 agent 辩论。
- manager/worker crew。
- agent handoff。
- 通用 DAG workflow runtime。
- 长期后台 autonomous scheduler。

原因：

- 当前单 Agent 还没有真实 eval、trace、safety、memory quality 闭环。
- 多 Agent 会放大工具误选、安全绕过、trace 难度和 token 成本。
- SunPilot 当前产品主场景是本地业务 agent + skills，不需要先进入多 Agent 复杂度。

进入 multi-agent 的前置条件：

- 真实 Golden Tasks 稳定通过。
- trace/plan/tool evidence 可持久化回放。
- sandbox/injection/permission 全路径可测。
- 单 Agent 在复杂多步骤任务中仍有明确不可解瓶颈。

## 推荐执行顺序

```text
P0-1 Real Golden Task harness
  -> P0-2 trace/plan/evidence persistence
  -> P0-3 safety denial as recoverable observation
  -> P1-4 tool decision metadata
  -> P1-5 model call unification
  -> P1-6 trace viewer/API
  -> P2 context/memory/provenance quality
  -> P3 MCP metadata compatibility
```

一句话：现在不是继续堆 Agent 概念，而是把已经接上线的 Agent Core 变成可测、可审计、可恢复、可解释的系统。
