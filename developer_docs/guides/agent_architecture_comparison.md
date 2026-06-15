# SunPilot vs 主流 Agent 架构对比分析

> 生成日期：2026-06-15  
> 对比基准：`developer_docs/guides/agent_core_architecture_implementation.md`（以下简称"蓝图"）  
> 参考来源：OpenAI Agents SDK、LangGraph、Anthropic Building Effective Agents、MemGPT、MCP Specification 等

---

## 1. 总体定位对比

| 维度 | 蓝图 Agent Core | SunPilot 实际实现 |
|------|----------------|-------------------|
| 架构哲学 | "模型驱动的任务操作系统" — 完整内核，覆盖从 Gateway 到 Evaluation 的全部层次 | "实用主义 Agent Loop" — 以 ReAct Loop 为核心，在关键路径上做深而非做全 |
| 设计重心 | 模块齐全（18+ 模块），强调生产级完备性 | 模块聚焦（12 个核心模块），强调端到端闭环 |
| 多 Agent | 支持 Handoff、Orchestrator-Workers、DAG Agents | 明确单 Agent + 多 Skill 策略，不做多 Agent |
| 部署模式 | 支持 Daemon/Scheduler 长期运行 | 以请求-响应为主，daemon 仅做进程托管 |

**核心差异：蓝图追求"全"，SunPilot 追求"深"。蓝图设计了一个可以支撑多 Agent、多租户、长期运行的操作系统级内核；SunPilot 选择在单 Agent 场景下把工具参数链路、记忆检索、上下文压缩、审批策略这些关键路径做到生产可用。**

---

## 2. 模块清单逐项对比

### 2.1 Agent Gateway

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 统一入口 | ✅ Agent Gateway 独立模块 | ✅ `JsonRpcRouter`（WebSocket）+ `registerRoutes`（REST） |
| 鉴权 | ✅ auth-context | ⚠️ 未实现独立鉴权层，依赖部署层 |
| 限流 | ✅ rate-limiter | ❌ 未实现 |
| 会话解析 | ✅ session-resolver | ✅ `conversationId` 贯穿全链路 |
| 幂等请求 | ✅ 通过 requestHash | ✅ `IdempotencyRepository` + `clientRequestId` |
| 多租户 | ✅ | ❌ 单租户设计 |

**差异分析：** 蓝图把 Gateway 作为独立安全边界，SunPilot 把 Gateway 逻辑分散在 JSON-RPC Router 和 AgentService 中。这是典型的"先做功能、后加固边界"策略。对于单用户本地部署场景，当前设计足够；要支持多租户 SaaS 则需要补鉴权/限流层。

---

### 2.2 Intent Router

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 意图类型 | 11 种（casual_chat, knowledge_query, tool_action, multi_step_task, plan_only 等） | 7 种（casual_chat, file_operation, shell_operation, memory_update, artifact_generation, automation_execution, use_skill） |
| 路由策略 | 三层：规则 → 小模型分类 → 主模型确认 | 两层：规则（regex + keyword）→ 可选 LLM |
| 输出结构 | `IntentResult` (type, confidence, reason, requiresPlanning, requiresTool, requiresApproval, candidateTools, candidateSkills, riskLevel) | `RoutedIntent` (type, confidence, requiresPlanning, requiresTool, requiresApproval, riskLevel, candidateSkills, reason) |
| 小模型专用 | ✅ 推荐独立分类模型 | ❌ 未实现，直接用主模型 |

**差异分析：** 蓝图设计了更丰富的意图类型（plan_only、approval_response、debug_previous_run、schedule_task），SunPilot 的意图类型更贴近当前实际支持的功能。两者的输出结构高度一致，SunPilot 的 `RoutedIntent` 实际上是 `IntentResult` 的子集。SunPilot 没有独立分类模型，这在当前工具数量少时不是问题，但工具规模增大后可能需要补上。

---

### 2.3 Context Builder

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 上下文分层 | 10 层（System/Developer/User/Session/Project/Task/Tool/Memory/File/Environment） | 7 层（system_persona/system_rules/safety_policy/current_message/conversation_history/memories/skill_catalog/tool_results/artifacts/run_state） |
| Token 预算 | ✅ 百分比分配策略 | ✅ `TokenBudgeter` 按优先级裁剪 |
| 上下文排序 | ✅ 公式：semantic×0.35 + recency×0.15 + authority×0.20 + relevance×0.20 + pin×0.10 | ✅ 基于 priority 数值的排序 + stale penalty |
| 上下文快照 | ✅ 保存到 trace | ✅ 保存到 `model_calls.metadata.context` |
| 防污染 | ✅ untrusted 标注、isolated context blocks | ✅ `TOOL_RESULT_RELIABILITY_RULES` + tool result 标注 |
| 历史附件 | ✅ | ✅ 历史消息附件通过 metadata 进入上下文 |
| 摘要压缩 | ✅ Compressor | ✅ conversation_summary + messageRange 跳过已摘要消息 |

**差异分析：** 这是 SunPilot 和蓝图最接近的模块。两者都实现了 token-aware 的上下文装配、优先级排序、快照保存。主要差异是蓝图设计了更细粒度的 context block 类型（developer、project、environment），而 SunPilot 更专注于当前对话工作集。蓝图的防污染策略更系统化（untrusted 标注），SunPilot 依赖 prompt 中的 reliability rules。

---

### 2.4 Memory Manager

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 记忆分层 | 6 层（L0 Working → L5 Reflective） | 3 层：explicit（用户显式）/ intent-based / task_summary |
| 写入流程 | 6 步：观察→候选→过滤→结构化→存储→后处理 | 4 步：candidate extraction → secret redaction → dedup → create/supersede/reject |
| 语义检索 | ✅ hybrid（keyword + vector + graph） | ✅ hybrid（keyword + pure vector），两段召回 |
| 矛盾处理 | ✅ supersedes/contradictedBy 关系 | ✅ supersede（`MemoryPolicy.classify()`），无 explicit contradiction |
| 记忆过期 | ✅ expiresAt | ✅ expiresAt |
| 记忆类型 | 12 种 | 10 种（user_preference, project_profile, technical_stack, deployment_info, error_solution, long_term_goal, conversation_summary, tool_observation, manual_note, workflow_pattern） |
| Vector DB | pgvector / Milvus / Qdrant | pgvector（HNSW index） |
| Graph Store | ✅ Neo4j 可选 | ❌ 未实现 |

**差异分析：** SunPilot 的记忆系统在写入过滤（secret redaction + dedup + policy）和检索（hybrid + pure vector）上已经比较完整。蓝图的最大差异是矛盾记忆处理（contradictedBy 关系）和图存储（实体关系），这两项对于当前单用户场景不是瓶颈，但在跨会话长期记忆中会变得重要。

---

### 2.5 Tool System

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| Tool Registry | ✅ `ToolRegistry` 接口 | ✅ `SkillRegistry`（skill 即 tool 的载体） |
| Tool Manifest | ✅ 20+ 字段 | ✅ `SkillSummary`（id, name, description, category, permissions, inputSchema, riskHints, timeout） |
| 三层漏斗 | Layer1 粗召回 → Layer2 精排 → Layer3 LLM Binding | Layer1 Regex rules → Layer2 Deterministic scoring → Layer3 LLM semantic |
| 粗召回评分 | embedding×0.40 + keyword×0.20 + tag×0.15 + category×0.10 + intent×0.10 | N/A（SunPilot 跳过粗召回，直接从 candidateSkills 匹配） |
| 精排评分 | recall×0.30 + task_fit×0.25 + permission×0.15 + history×0.10 + ... | `scoreSkills()` 基于 id/name/description/bigram 匹配 |
| 动态 Top-K | ✅ 按 intent 类型 | ❌ 未实现 |
| 工具去重/分组 | ✅ ToolGroup | ❌ 未实现 |
| 参数生成 | 模型直接输出 | ✅ `DefaultToolArgumentBuilder`（7 优先级策略） |
| 参数校验 | ✅ schema validate | ✅ `validateArguments()` + repair loop |
| 工具执行 | ✅ Tool Executor（sandbox、timeout、retry） | ✅ `ExecutionOrchestrator`（并发控制、retry、event emit） |

**差异分析：** 这是 SunPilot 设计上最有特色的模块。蓝图的三层漏斗从"海量工具中筛选"的角度设计，假设工具池很大（100+）；SunPilot 的三层漏斗从"精准匹配"的角度设计，假设工具通过 intent 已经预筛选。SunPilot 独有的亮点是 **schema-aware 参数生成器**（7 级优先级）和 **参数 repair loop**，这两点在蓝图中没有细化到同等程度。

SunPilot 目前缺少工具去重/分组机制和基于 intent 的动态 Top-K。在当前工具数量（<30）下不是问题，但如果接入 MCP 或大量第三方工具，需要补上粗召回层。

---

### 2.6 Planning Engine

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| ReAct Loop | ✅ | ✅ `AgentLoopEngine` 核心模式 |
| Plan-then-Execute | ✅ 独立 Planner + Plan Validator + Replanner | ✅ `RuleBasedPlanner` + plan steps |
| DAG Workflow | ✅ dag-planner | ❌ 未实现 |
| Plan 数据结构 | ✅ AgentPlan（goal, assumptions, steps, risk, status） | ✅ AgentPlan（id, goal, summary, steps） |
| Plan Validator | ✅ 循环检测、依赖、权限、风险 | ❌ 未实现（规划验证依赖模型自身） |
| Replanning | ✅ 7 种触发条件 | ❌ 未实现（只有 reflection continue/respond 二选一） |

**差异分析：** SunPilot 的规划能力相对蓝图较弱。蓝图有完整的 Plan → Validate → Execute → Replan 循环，SunPilot 的 Planner 目前只是生成 plan 步骤但不做深度验证。Replanning 在 SunPilot 中由 reflection 引擎部分覆盖（`nextAction: continue`），但没有蓝图那种结构化的 replan 触发条件（工具失败、结果不符合预期、用户改目标等）。

这是 SunPilot 如果要处理更复杂任务时最需要补强的模块。

---

### 2.7 Agent Loop Engine

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 状态机 | created → running → waiting_approval → completed/failed/cancelled | created → context_building → intent_routing → planning? → tool_deciding → executing → reflecting → responding → completed/failed/cancelled/interrupted |
| 运行模式 | chat/agent/workflow/plan/auto/approval_required/dry_run | chat/agent |
| 最大迭代 | 未明确 | `MAX_TOOL_ITERATIONS = 5` |
| 停止条件 | ✅ stop-condition 模块 | ✅ reflection stopReason + max_iterations |
| 审批恢复 | ✅ checkpoint → resume | ✅ `resumeApprovedTool()` + `continueAfterRejection()` |

**差异分析：** SunPilot 的 Agent Loop Engine 状态粒度比蓝图更细。蓝图只有 5 个宏观状态，SunPilot 有 10 个微观状态（context_building、intent_routing、tool_deciding、executing、reflecting、responding 等）。这种细粒度设计让事件流和前端状态跟踪更精确。蓝图的运行模式更丰富（workflow、plan、dry_run），SunPilot 目前只支持 chat/agent 两种。

---

### 2.8 Safety / Guardrails

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| Risk Classifier | ✅ 独立 risk-classifier | ✅ `classifyRisk()` in safety-types |
| Policy Engine | ✅ policy-engine | ✅ `PermissionPolicy`（支持 ask/auto/full 三种模式） |
| Approval Manager | ✅ approval-manager | ✅ `RepositoryApprovalGate` + `RepositoryApprovalDecisionService` |
| Prompt Injection 检测 | ✅ | ❌ 未实现（依赖 prompt 层面的 reliability rules） |
| Sandbox | ✅ sandbox-policy | ❌ 未实现（工具执行依赖 skill-runner 自身的沙箱） |
| PII Redaction | ✅ pii-redactor | ✅ `PatternSecretRedactor`（密钥/密码等敏感信息扫描） |
| Least Privilege | ✅ task-scoped tool access | ⚠️ 部分：基于 risk level 的权限控制，但非 task-scoped |

**差异分析：** SunPilot 在审批和风险分级上做得比较完整（三种 permission mode + risk-based decision + 三种 rejection strategy）。但蓝图有两个 SunPilot 缺失的关键安全层：prompt injection detection 和 sandbox。对于当前本地使用场景，风险可控；生产部署需要补上。

---

### 2.9 State Manager

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| Run State | ✅ agent_runs 表 | ✅ runs 表 |
| Step State | ✅ agent_steps 表 | ✅ steps 表 |
| Tool Call State | ✅ tool_calls 表 | ✅ tool_calls 表（含 metadata/repairHistory） |
| Approval State | ✅ approvals 表 | ✅ approvals 表 |
| Checkpoint | ✅ RunCheckpoint（context + plan + step + tool result） | ✅ context snapshot 保存到 model_calls.metadata |
| State Machine | ✅ LEGAL_TRANSITIONS | ✅ LEGAL_TRANSITIONS（run-state-machine.ts） |
| Resume | ✅ checkpoint load → resume | ✅ resumeRun / retryRun |
| Task State 持久化 | 未明确 | ✅ taskState（completedSteps, pendingSteps, gatheredFacts, openQuestions） |

**差异分析：** SunPilot 在状态管理上甚至比蓝图多了一些设计——taskState 持久化在蓝图中没有明确提及，SunPilot 实现了跨迭代的 task state 追踪和持久化。两者的数据库表结构高度相似。

---

### 2.10 Event Bus

| 特性 | 蓝图设计 | SunPilot 实现 |
|------|---------|---------------|
| 事件类型 | 17 种 | 30 种（agent.run.*, agent.context.*, agent.intent.*, agent.plan.*, agent.tool.*, agent.approval.*, agent.model.*, agent.response.*, agent.memory.*, agent.error） |
| 事件结构 | AgentEvent（id, runId, type, timestamp, payload, visibility） | AgentEventEnvelope（eventId, sequence, runId, conversationId, type, payload, createdAt） |
| 持久化 | 未明确 | ✅ `RepositoryAgentEventSink` → events 表 |
| WebSocket 推送 | ✅ | ✅ `JsonRpcRouter` → WebSocket notify |
| 去重 | 未明确 | ✅ sequence-based dedup（`lastSequenceRef`） |
| Replay | 未明确 | ✅ `replayConversationEvents` |

**差异分析：** SunPilot 的事件系统比蓝图更完善——更多事件类型、持久化、去重、replay 都实现了。蓝图的事件设计相对简洁，偏向"推送 UI 更新"，SunPilot 的设计偏向"可审计的事件溯源"。

---

### 2.11 蓝图有但 SunPilot 没有的模块

| 模块 | 蓝图定位 | 缺失原因分析 |
|------|---------|-------------|
| **Tracing** | LLM call/tool call/context 全链路追踪 | SunPilot 有 context snapshot + model_calls 表，但缺少独立的 trace viewer 和 span 结构 |
| **Evaluation** | 单元评估 + Golden Task + 人工评估 | 未实现。对于当前阶段，代码审查和手动测试替代了自动评估 |
| **Model Router** | 按任务类型路由到不同模型 | SunPilot 使用单一 LlmProvider。小模型分类、embedding 等场景未做模型隔离 |
| **Scheduler/Daemon** | 定时任务、条件触发、后台监控 | SunPilot 的 daemon 包只做进程托管，无任务调度能力 |
| **Handoff/Multi-Agent** | Router Agent → Specialist Agents | 明确选择不做。SunPilot 采用"单 Agent + 多 Skill"策略 |
| **Graph Store** | Neo4j 实体关系 | 未实现。当前 memory 仅使用 pgvector，不做图关系 |

**这些缺失大部分是刻意的架构选择，而非遗漏。** SunPilot 遵循 Anthropic "Building Effective Agents" 的建议——优先单 Agent + 多工具，不被多 Agent 复杂性拖累。

---

## 3. SunPilot 相对蓝图的独特设计

### 3.1 Schema-Aware Argument Builder

蓝图的工具参数生成依赖模型直接输出。SunPilot 设计了 7 级优先级的参数生成器：

```
Plan step input → Schema required fields → Message URLs/IDs/Filenames
→ Attachments → Previous structured result → LLM structured output
→ ask_clarification
```

这是 SunPilot 最独特的工程贡献——不是"让模型生成参数然后祈祷"，而是"系统性地从多个来源收集参数，最后才求助 LLM"。

### 3.2 Parameter Repair Loop

蓝图没有细化的参数修复机制。SunPilot 实现了：

```
validate → fail → heuristic repair (type coercion, enum matching)
→ LLM repair → re-validate → execute
```

且有完整的 `repairHistory` 审计（original args, validation errors, repair attempts, final args）。

### 3.3 Reflection-Driven Multi-Turn

SunPilot 的 reflection 引擎不只是判断"目标是否完成"，还输出 `nextToolCandidates`（带 `argumentsHint`），这些候选会作为 `prioritySkills` 直接驱动下一轮工具选择。蓝图对此的描述是"Replanning"，但 SunPilot 实现得更具体。

### 3.4 Permission Mode（ask/auto/full）

蓝图把审批策略放在服务端。SunPilot 把权限模式的选择权交给用户——前端 ChatComposer 中的 ask/auto/full 选择器会贯穿全链路影响 `PermissionPolicy` 的决策。这是用户体验上的差异化设计。

### 3.5 Conversation Summary with Stale Detection

蓝图的 summary 设计是"写 summary 替换旧消息"。SunPilot 在此基础上加了：

- **messageRange** 精确跟踪覆盖范围
- **stale detection** 检查 summary 之后是否有新消息
- **quality scoring** 基于 reflection confidence + tool success rate
- **version tracking** 每 10 条消息递增版本号

---

## 4. 架构选型的关键差异总结

| 设计决策 | 蓝图偏好 | SunPilot 选择 | 判断 |
|---------|---------|---------------|------|
| Agent 数量 | 支持 Multi-Agent | 单 Agent | ✅ 符合 Anthropic 建议，当前阶段正确 |
| 规划模式 | Plan-then-Execute + DAG | ReAct + 简单 Plan | ⚠️ 复杂任务可能需要更强规划 |
| 工具匹配 | 全量粗召回 → 精排 | Intent 预筛选 → 评分匹配 | ✅ 工具少时更高效，多了需要补粗召回 |
| 参数生成 | 模型直接生成 | 7 级优先级 + repair loop | ✅ SunPilot 方案更可靠 |
| 权限控制 | 服务端策略 | 用户可选模式 | ✅ 差异化设计 |
| 记忆检索 | keyword + vector + graph | keyword + pure vector | ⚠️ 缺少图关系，长期间可能不足 |
| 模型路由 | 按任务类型分模型 | 单一模型 | ⚠️ 成本优化空间大 |
| 安全沙箱 | 独立 sandbox 模块 | 依赖 skill-runner | ⚠️ 生产部署需要加强 |

---

## 5. 成熟度评估

按蓝图的 6 个 Phase 评估 SunPilot 的完成度：

| Phase | 蓝图目标 | SunPilot 完成度 |
|-------|---------|----------------|
| Phase 1: 单 Agent 可运行 | run/step/tool_call 表 + 内置工具 + Plan-Execute + WebSocket | ✅ **100%** |
| Phase 2: 上下文与记忆 | Context Builder + Memory + Embedding + Summary | ✅ **90%**（缺 graph store） |
| Phase 3: 工具三层漏斗 | Tool Manifest + Embedding + 粗召回 + 精排 + 动态 Top-K | ✅ **80%**（缺粗召回层和动态 Top-K） |
| Phase 4: 审批与安全 | Risk Classifier + Approval + Policy + Sandbox + Audit | ✅ **75%**（缺 sandbox 和 prompt injection detection） |
| Phase 5: Skill System | Skill Manifest + Registry + Router + Plan 编译 | ✅ **85%**（有完整的 skill-runner 和 skill-sdk） |
| Phase 6: Daemon 与长期运行 | Scheduler + Background Worker + Checkpoint Resume + Evaluation | ⚠️ **30%**（只有 daemon 进程托管和 checkpoint resume） |

---

## 6. 结论

**SunPilot 不是一个"蓝图的不完整实现"，而是一个有独立架构判断的 Agent Core。**

它的核心策略是：

1. **在关键路径上做深**：工具参数生成、参数修复、记忆混合检索、上下文 token 预算、审批策略都比蓝图更细化。
2. **在不需要的地方做减**：不做多 Agent、不做图数据库、不做复杂调度。这些在当前阶段是正确选择。
3. **有差异化设计**：permission mode 用户可选、reflection 驱动下一轮工具选择、summary stale detection 是蓝图没有覆盖的工程细节。

如果 SunPilot 要继续演进，最值得补的三个模块是：

1. **Planning 增强**：Plan Validator + Replanner，让复杂多步骤任务更可靠。
2. **Evaluation 框架**：Golden Task 回归测试，让 Agent 行为可量化验证。
3. **Model Router**：不同任务用不同模型（小模型分类、embedding 专用模型），降低 token 成本。

但就当前阶段而言，SunPilot 的 Agent Core 已经达到了"可在本地可靠运行"的水平，核心闭环（context → intent → tools → execute → reflect → respond → memory）是完整且经过验证的。
