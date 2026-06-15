# Agent 架构下一步完善清单

更新时间：2026-06-15  
依据文档：`developer_docs/guides/agent_architecture_comparison.md`

## 总体判断

`agent_architecture_comparison.md` 的结论不是 SunPilot 要照搬一个“大而全”的 Agent OS，而是要沿着当前“单 Agent + 多 Skill + 深关键路径”的方向继续补强。

当前核心闭环已经成立：

```text
context -> intent -> plan/tool decision -> execute -> reflect -> respond -> memory
```

下一步最值得完善的不是 Multi-Agent、DAG 工作流或复杂后台调度，而是让现有单 Agent 在复杂任务、长上下文、工具规模增长、生产安全和行为回归上更稳定。

优先级建议：

1. 增强 Planning：补 Plan Validator 与 Replanner。
2. 建立 Evaluation：用 Golden Tasks 固化 Agent 行为。
3. 增加 Model Router：拆分分类、参数生成、总结、embedding 等模型职责。
4. 强化安全边界：补 prompt injection 检测、sandbox 和 task-scoped 权限。
5. 扩展工具召回：为 MCP/大量 Skill 场景补粗召回、动态 Top-K、工具分组。
6. 完善长期记忆：补真实 embedding provider、矛盾记忆关系、记忆质量评估。

## 1. Planning 增强

### 当前状态

SunPilot 已有 `RuleBasedPlanner`、plan steps、ReAct loop 和 reflection continue/respond 机制，但规划仍偏轻量。复杂多步骤任务主要依赖模型自我判断和 reflection，而不是结构化的计划验证与重规划。

### 需要完善

- 增加 `PlanValidator`：
  - 检查 plan step 是否缺目标、缺输入、缺依赖。
  - 检查是否存在循环依赖。
  - 检查 step risk 与 permission mode 是否匹配。
  - 检查需要审批的步骤是否提前标注。
  - 检查 plan 是否能在当前工具集合中执行。
- 增加结构化 `Replanner`：
  - 工具失败后生成替代步骤。
  - 用户修改目标后重写后续步骤。
  - 工具结果不满足预期时补充验证步骤。
  - 缺少参数时将澄清问题纳入 plan state。
- 扩展 plan step 状态：
  - `blocked`
  - `skipped`
  - `waiting_approval`
  - `needs_clarification`
  - `verified`
- 将 `taskState` 与 plan step 更紧密关联，避免 reflection 只以自然语言判断任务是否完成。

### 验收标准

- 工具失败后不会直接早停，可以生成替代计划或明确说明不可继续。
- 用户中途改变目标时，已完成步骤保留，未完成步骤重排。
- 复杂任务能显示哪些 step 已完成、哪些 step 被跳过、哪些 step 需要用户输入。
- Replanner 的行为有端到端测试覆盖。

## 2. Evaluation 框架

### 当前状态

SunPilot 目前主要依赖代码审查、手动测试和局部单元测试判断 Agent 行为。Agent loop、工具调用、审批、上下文压缩、记忆召回等行为缺少稳定的 Golden Task 回归评估。

### 需要完善

- 建立 `evals/agent` 目录或独立测试包。
- 定义 Golden Task 数据格式：
  - 用户输入。
  - 初始会话历史。
  - 附件。
  - 可用工具集合。
  - 权限模式。
  - 期望工具调用。
  - 期望最终回答约束。
  - 禁止行为。
- 增加核心评估集：
  - 图片/附件搜索同款货源必须等待工具结果。
  - 工具参数缺失时必须澄清或 repair，不能伪造结果。
  - 用户拒绝工具后必须继续完成可完成部分。
  - summary 覆盖旧消息后不能丢失关键约束。
  - memory recall 必须召回用户长期偏好。
  - prompt injection 工具结果不能覆盖系统规则。
- 增加评估报告：
  - pass/fail。
  - 实际工具调用序列。
  - 实际上下文快照摘要。
  - 模型调用次数和 token 消耗。
  - 失败原因分类。

### 验收标准

- 每次修改 Agent Core 后能运行固定 Golden Task。
- 能检测“LLM 提前回答、没有等待工具结果”的回归。
- 能检测“工具返回为空却编造结果”的回归。
- 能检测“上下文压缩丢关键约束”的回归。

## 3. Model Router

### 当前状态

SunPilot 使用单一 `LlmProvider` 承担意图识别、工具参数生成、反思、总结、最终回答等职责。embedding 服务如果没有真实 provider，会回退到关键词/哈希向量。

### 需要完善

- 增加 `ModelRouter`：
  - intent classification 使用低成本模型。
  - tool argument generation 使用结构化输出能力强的模型。
  - reflection 使用稳定推理模型。
  - response composition 使用主对话模型。
  - summary/compression 使用低成本长上下文模型。
  - embedding 使用专用 embedding provider。
- 为每类模型调用记录：
  - model name。
  - purpose。
  - latency。
  - token usage。
  - fallback reason。
- 增加 fallback 策略：
  - 小模型失败时回退主模型。
  - embedding provider 不可用时显式进入 degraded mode。
  - 结构化输出失败时进入 repair path。

### 验收标准

- 不同任务类型能路由到不同模型配置。
- embedding provider 是否真实启用在日志和 metadata 中可见。
- 模型失败时不会让整个 run 无声失败。
- token 成本和延迟能按 purpose 统计。

## 4. 工具召回与 Tool System 扩展

### 当前状态

SunPilot 的工具系统在参数生成和 repair 上很强，但工具召回更适合当前工具数量较少的场景。如果未来接入 MCP、大量第三方工具或更多 Skill，需要补蓝图里的粗召回和动态 Top-K。

### 需要完善

- 增加工具粗召回层：
  - keyword match。
  - capability/category match。
  - permission/risk match。
  - embedding similarity。
  - recent success/failure history。
- 增加动态 Top-K：
  - casual chat：0。
  - simple tool action：1-3。
  - multi-step task：3-8。
  - ambiguous task：优先澄清。
- 增加工具去重和分组：
  - 同类工具只保留最适合的候选。
  - 同一 MCP server 的多个相似工具做 group 展示。
  - 降低模型看到过多近似工具的概率。
- 强化 Tool Manifest：
  - 输入 schema 完整度。
  - 输出 schema。
  - side effects。
  - idempotency。
  - timeout/retry policy。
  - examples。

### 验收标准

- 工具数量增加到 100+ 时，模型仍只看到少量高相关工具。
- 不会因为相似工具过多导致误选。
- Top-K 大小随 intent 和 task complexity 自动变化。
- 工具选择原因可追踪。

## 5. 安全与 Guardrails

### 当前状态

SunPilot 已有 risk classifier、permission policy、approval gate、secret redaction。主要缺口是 prompt injection 检测、工具 sandbox 和更细粒度的 task-scoped 权限。

### 需要完善

- 增加 prompt injection detector：
  - 对网页内容、工具结果、附件解析文本做不可信标记。
  - 检测“忽略之前指令”“泄露系统提示”“调用危险工具”等模式。
  - 将检测结果写入 context block metadata。
- 增加工具 sandbox：
  - 文件系统访问限制。
  - shell 命令白名单/黑名单。
  - 网络访问控制。
  - 超时和资源限制。
- 增加 task-scoped permission：
  - 权限只对当前 run 或当前 plan step 生效。
  - 用户批准某工具不等于批准所有同类工具。
  - 高风险工具必须重新确认。
- 增强审计：
  - 记录审批原因。
  - 记录被拒绝工具后 agent 的替代行动。
  - 记录危险输入被拦截的原因。

### 验收标准

- 不可信工具结果不能覆盖 system/developer/user 约束。
- 高风险 shell/file/network 操作必须进入审批或被阻止。
- 用户批准范围不会泄漏到无关任务。
- 审计日志能还原一次危险操作为什么被允许或拒绝。

## 6. 长期记忆与上下文质量

### 当前状态

SunPilot 已有 memory writer、dedup、secret redaction、conversation summary、messageRange、hybrid + pure vector recall。下一步重点不是再加更多记忆类型，而是提升检索质量、矛盾处理和摘要可靠性。

### 需要完善

- 接入真实 embedding provider。
- 为 message、memory、summary 记录 embedding model 和维度。
- 补齐 user/system 消息 embedding。
- 增加 contradiction relation：
  - `supersedes`
  - `contradicts`
  - `resolvedBy`
- 增加 memory quality score：
  - 来源可信度。
  - 最近使用时间。
  - 是否被用户显式确认。
  - 是否与当前任务相关。
- 强化 summary stale detection：
  - 新消息改变目标时标记 stale。
  - 工具结果改变事实时标记 stale。
  - 用户纠正信息时标记 stale。

### 验收标准

- 长对话压缩后仍能保留用户目标、限制、工具证据和未完成事项。
- 新偏好能覆盖旧偏好，而不是同时召回互相冲突的信息。
- 语义召回质量可通过 evals 验证。
- fallback embedding 状态明确可见。

## 7. Tracing 与可观测性

### 当前状态

SunPilot 已有 model_calls、context snapshot、events、tool_calls metadata，但缺少统一 trace/span 视角。

### 需要完善

- 增加 trace id，贯穿 run、model call、tool call、approval、memory write。
- 定义 span：
  - context_building。
  - intent_routing。
  - planning。
  - tool_deciding。
  - tool_executing。
  - reflecting。
  - responding。
  - memory_writing。
- 建立 trace viewer 或调试导出：
  - 每一步耗时。
  - 输入摘要。
  - 输出摘要。
  - 错误和 retry。
  - token usage。
- 对关键事件建立指标：
  - 工具调用成功率。
  - 参数 repair 率。
  - 审批通过/拒绝率。
  - 早停率。
  - memory 命中率。

### 验收标准

- 一次异常回答可以追溯到具体 context、tool result、reflection 或 memory recall。
- 能统计哪些工具最容易参数失败。
- 能判断成本主要花在意图识别、反思、总结还是最终回答。

## 8. 前端对话体验

### 当前状态

架构比较文档主要看后端 Agent Core，但 SunPilot 的关键用户体验是对话页。前端需要严格遵守：用户消息、图片、附件发出后立即响应，所有后端请求都在背后默默完成。

### 需要完善

- 发送消息后立即插入 user bubble。
- 立即插入 assistant pending bubble。
- 附件选择后立即展示本地 pending 附件。
- 上传、run 创建、工具调用、最终回答分离状态，但视觉上保持连续等待。
- 失败后保留原消息和附件，允许重试。
- 不展示 `AgentTimeline` 到主对话界面。

### 验收标准

- 慢网络下用户点击发送后 100ms 内看到本地反馈。
- 图片上传未完成时，也能看到消息和附件 pending 状态。
- 后端工具调用耗时较长时，assistant pending 不消失。
- 上传失败不会丢失用户输入。

## 不建议近期投入的方向

以下方向在架构比较文档中属于蓝图能力，但不应作为近期优先级：

- Multi-Agent / Handoff。
- DAG Workflow。
- Neo4j Graph Store。
- 复杂 Scheduler / Background Worker。
- 大而全 Trace Viewer。
- CLI `sun chat` / `sun ask`。

原因是当前 SunPilot 的优势在单 Agent 关键路径深度。过早引入这些模块会增加复杂性，却不能直接解决“工具调用是否可靠、任务是否完成、上下文是否正确、前端是否及时响应”的核心问题。

## 推荐实施顺序

### 第一阶段：可靠性闭环

1. Plan Validator。
2. Replanner。
3. Golden Task evals。
4. 工具参数 repair 端到端测试。
5. 审批拒绝后续跑测试。

### 第二阶段：语义质量

1. 真实 embedding provider。
2. message embedding 全角色覆盖。
3. summary 质量规则。
4. memory contradiction relation。
5. memory recall evals。

### 第三阶段：规模化

1. Model Router。
2. 工具粗召回。
3. 动态 Top-K。
4. Tool Group。
5. trace/span 指标。

### 第四阶段：生产加固

1. Prompt injection detector。
2. Tool sandbox。
3. task-scoped permission。
4. 审计报表。
5. 前端完整发送/上传/等待/失败状态机。

## 最终目标

下一步完善的目标不是让 SunPilot 变成另一个复杂 Agent 平台，而是让当前单 Agent 架构达到更稳定的生产级表现：

- 不提前结束任务。
- 不伪造工具结果。
- 不丢失长上下文关键约束。
- 不把不可信工具内容当成高优先级指令。
- 不因为工具数量增加而误选工具。
- 不让用户在图片、附件、慢请求场景下感到页面无响应。
- 能用 evals 持续证明这些能力没有回退。
