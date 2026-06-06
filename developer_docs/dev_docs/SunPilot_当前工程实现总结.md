# SunPilot 当前工程实现总结

更新时间：2026-06-07

本文档总结当前 SunPilot 工程架构、核心模块边界、运行链路和主要实现状态，作为开发、审查和后续重构时的工程地图。

## 1. 项目定位

SunPilot 是一个 daemon-first 的本地业务 Agent 运行时。它的核心目标不是只做一个聊天前端，而是在本机 daemon 中承载：

- Web Chat 交互入口。
- Agent Loop：理解意图、构建上下文、规划、选工具、执行、审批、反思、回复。
- Skill 生态：开发、安装、扫描、权限控制和执行外部能力。
- Workflow 生态：预定义业务流程的注册和执行。
- PostgreSQL 持久化：run、event、message、approval、artifact、memory、tool/model call、audit 等。
- CLI launcher：通过 `sun` / `sunpilot` 启停 daemon、打开 Web、查看日志和状态。

当前工程已经形成端到端闭环：

```text
Browser Web
  <-> daemon WebSocket JSON-RPC / REST
  <-> core AgentService / AgentKernel / Runtime
  <-> storage PostgreSQL repositories
  <-> skill-runner / workflow runtime / LLM provider
```

## 2. 总体运行架构

```text
Browser
  |
  | HTTP / WebSocket
  v
SunPilot daemon (Fastify)
  |
  | JSON-RPC command routing
  v
AgentService (core/src/agent)
  |
  | Agent Loop
  v
agent-kernel
  |       |          |
  |       |          +--> LLM provider -> OpenAI-compatible HTTP SSE
  |       |
  |       +--> SkillRunner -> installed skills
  |
  +--> Workflow runtime -> workflow steps -> providers/skills
  |
  v
Storage repositories -> PostgreSQL
```

前端和 daemon 之间使用 WebSocket JSON-RPC 推送 Agent 事件；daemon/core 和大模型之间使用 OpenAI-compatible HTTP streaming，也就是请求 `stream: true` 后解析 SSE `data:` 流。

## 3. Monorepo 包边界

| 包 | 职责 |
| --- | --- |
| `@sunpilot/protocol` | 跨包/跨端共享协议，定义数据类型、Zod schema、Agent 命令、Agent 事件、Agent 错误码。 |
| `@sunpilot/storage` | 数据访问层，包含 repository 接口、Postgres 实现、migration、测试用内存数据库、本地路径和 artifact 文件写入。 |
| `@sunpilot/core` | 核心业务层，包含 AgentService、AgentKernel、Workflow Runtime、LLM provider、provider 抽象和内部错误。 |
| `@sunpilot/daemon` | 本地服务进程，提供 Fastify REST、WebSocket JSON-RPC、静态 Web 托管、composition root 和运行时恢复。 |
| `@sunpilot/web` | React + Ant Design Web 前端，当前以 ChatPage 为主，展示对话、Agent timeline、approval、artifact。 |
| `@sunpilot/launcher` | `sun` / `sunpilot` CLI，负责启动、停止、状态、doctor、日志和打开 Web。 |
| `@sunpilot/skill-sdk` | 给技能作者使用的 SDK，定义标准 skill 结构、capability、handler context 和测试 helper。 |
| `@sunpilot/skill-runner` | 技能运行时，扫描 manifest、注册技能、权限检查、动态 import、执行 handler、写 audit/event/artifact/memory。 |
| `@sunpilot/workflow` | Workflow 定义和 registry，目前是薄抽象，执行逻辑在 `core/runtime`。 |
| `tests/integration` | 跨包集成测试，当前覆盖 daemon/WebSocket Agent 链路。 |

## 4. 核心概念关系

### Agent

Agent 是动态决策者。用户输入一条消息后，Agent 会判断意图、构建上下文、决定是否需要工具、是否需要审批、是否需要工作流，最后生成回复。

入口在：

```text
packages/core/src/agent/agent.service.ts
```

Agent 内部执行引擎在：

```text
packages/core/src/agent-kernel/
```

### Skill

Skill 是原子能力。它回答“系统能做什么”，例如读文件、写文件、生成 artifact、查询外部系统、执行某个业务动作。

开发标准在：

```text
packages/skill-sdk/
```

运行执行在：

```text
packages/skill-runner/
```

### Workflow

Workflow 是预定义业务流程。它回答“为了完成某个业务目标，应该按什么步骤做”。Workflow 内部步骤最终可以调用 skill/provider。

定义和 registry 在：

```text
packages/workflow/
```

执行在：

```text
packages/core/src/runtime/runtime.service.ts
```

三者关系：

```text
Agent
  ├─ 可以直接调用 Skill
  └─ 可以启动 Workflow
          └─ Workflow step 可以调用 Skill
```

## 5. protocol 包

`protocol` 是公共契约层，尽量只放稳定的跨端协议，不放业务实现。

主要文件：

- `types.ts`：run、step、event、approval、artifact、memory、skill、workflow 等共享类型。
- `schemas.ts`：传统 REST/Runtime 请求 schema。
- `agent-commands.ts`：WebSocket JSON-RPC 命令 schema/type，例如 `chat.send`、`chat.stop`、`run.retry`、`approval.approve`。
- `agent-events.ts`：`agent.*` 事件词表和 payload 类型。
- `agent-errors.ts`：`AGENT_*` 错误码、错误分类、JSON-RPC 错误码映射。

`protocol/src/agent-errors.ts` 和 `core/src/errors` 的区别：

- `protocol/agent-errors` 是对外协议错误码。
- `core/errors` 是 core 内部 `Error` class 和 HTTP/runtime 映射。

## 6. storage 包

`storage` 是数据访问层，核心目标是让 core/daemon 依赖 repository 抽象，而不是直接依赖 SQL。

目录职责：

| 目录 | 职责 |
| --- | --- |
| `database/` | 数据库配置、工厂、`DatabaseContext` 聚合接口。 |
| `repositories/` | 每类数据的 repository interface，如 run/event/memory/approval/tool-call。 |
| `postgres/` | repository 的 Postgres 实现、transaction、migration runner。 |
| `migrations/` | SQL schema 演进脚本。 |
| `testing/` | 测试用内存 `DatabaseContext`。 |

当前持久化覆盖：

- conversation / message
- run / step / job
- event replay
- approval
- artifact metadata
- memory
- audit log
- installed skills
- workflows
- idempotency keys
- tool calls
- model calls
- run status history

### SQL migrations

`migrations/*.sql` 是数据库版本演进脚本，由 `postgres/postgres.migrations.ts` 按顺序执行，并记录到 `schema_migrations` 表中，保证每个 migration 只执行一次。

当前 migration 作用：

| 文件 | 作用 |
| --- | --- |
| `001_init.sql` | 创建基础 `runs`、`events`、`settings`。 |
| `002_conversations.sql` | 创建 `conversations`，给 run 增加 conversation 外键。 |
| `003_messages.sql` | 创建 `messages`。 |
| `004_runtime_aux.sql` | 创建 approvals、artifacts、memory_metadata、audit_logs。 |
| `005_runtime_steps_jobs.sql` | 创建 steps、job_queue。 |
| `006_catalog.sql` | 创建 workflows、installed_skills。 |
| `007_agent_runtime_core.sql` | 增加 Agent run 字段、event sequence、run_status_history。 |
| `008_agent_events_sequence.sql` | 增加 event replay/filter 相关索引。 |
| `009_agent_idempotency.sql` | 创建 idempotency_keys、tool_calls、model_calls。 |
| `010_agent_observability.sql` | 增强 approval/artifact/audit 可观测字段。 |
| `011_memory_core.sql` | 增强长期记忆 scope/type/content/source/confidence/soft delete 等字段。 |

## 7. core 包

`core` 是业务核心层，分为几块。

### agent

目录：

```text
packages/core/src/agent/
```

职责：

- 对 daemon/API 暴露 AgentService facade。
- 处理 `chat.send`、stop、cancel、resume、retry、approve、reject。
- 创建 conversation/message。
- 处理 clientRequestId 幂等。
- 兼容旧 `chat()` API。
- 调用 `AgentLoopEngine` 完成真正执行。

### agent-kernel

目录：

```text
packages/core/src/agent-kernel/
```

职责：

- `agent-loop-engine.ts`：Agent Loop 状态机。
- `context/`：构建上下文，收集 history、memory、skills、artifacts、tool results。
- `intent/`：意图识别，规则优先，必要时用 LLM 分类。
- `planning/`：基于规则生成计划。
- `tools/`：根据 intent/plan 匹配 skill/workflow/no_tool。
- `safety/`：权限和风险判断，决定 allow/approval/reject。
- `execution/`：执行 tool calls，记录 tool_calls 和 events。
- `response/`：调用 LLM 流式生成 assistant 回复，并保存 message/model call。
- `memory/`：记忆写入策略、内容提取、脱敏。
- `persistence/`：基于 repository 的 run 状态、approval、event sink。

`agent` 和 `agent-kernel` 的区别：

```text
agent        = 服务入口 / facade / 生命周期操作
agent-kernel = 内部执行引擎 / Agent Loop 机制
```

### runtime

目录：

```text
packages/core/src/runtime/
```

职责：

- 执行传统 Workflow Runtime。
- 根据 `workflowId` 找 workflow。
- 调用 `workflow.plan()` 生成 steps。
- 持久化 run/job/steps/events。
- 按 step 调用 ToolProvider。
- 处理 approval、cancel、interrupt、retry。

这部分和 Agent Runtime 并行存在：Agent 可以动态调用 skill，也可以启动一个 workflow run。

### llm

目录：

```text
packages/core/src/llm/
```

职责：

- 定义 LLM provider interface。
- 从环境变量创建默认 OpenAI-compatible provider。
- 通过 HTTP POST `/chat/completions`，请求体带 `stream: true`。
- 解析 SSE `data:` 流，yield delta。

默认配置：

- `SUNPILOT_LLM_API_KEY` 或 `DEEPSEEK_API_KEY`
- `SUNPILOT_LLM_BASE_URL`
- `SUNPILOT_LLM_MODEL`

### providers

目录：

```text
packages/core/src/providers/
```

职责：

- 定义 ToolProvider/ToolCapability 抽象。
- `SkillProvider` 将 skill-runner 暴露为 runtime 可调用 provider。
- `McpProviderStub` 当前是 MCP 能力占位。

## 8. daemon 包

`daemon` 是本地服务进程，负责把 core、storage、skill-runner、workflow、web 组装起来。

关键文件：

- `main.ts`：进程入口，解析启动参数，写 pid/log。
- `server.ts`：Fastify 主服务，提供 REST、WebSocket、静态资源、metrics、diagnostics、recovery。
- `composition-root.ts`：组装 Agent Loop 的所有依赖。
- `json-rpc-router.ts`：WebSocket JSON-RPC 命令路由。
- `connection-registry.ts`：维护 WebSocket 连接和 run/conversation subscription。
- `event-streamer.ts`：把 runtime/agent event 分发给订阅连接。
- `ws-protocol.ts`：WebSocket notification 和 error envelope 规范化。

daemon 启动时会：

1. 创建或接收 `DatabaseContext`。
2. 运行 PostgreSQL migration。
3. 恢复 interrupted/stale runtime 状态。
4. 初始化 SkillRegistry、SkillRunner。
5. 初始化 WorkflowRegistry 和 SunPilotRuntime。
6. 懒加载 AgentService。
7. 注册 REST routes 和 WebSocket server。
8. 托管 Web dist 静态资源。

## 9. WebSocket 与 REST

WebSocket 入口：

```text
/v1/ws
```

主要 JSON-RPC method：

- `chat.send`
- `chat.stop`
- `conversation.subscribe`
- `conversation.unsubscribe`
- `run.create`
- `run.subscribe`
- `run.unsubscribe`
- `run.cancel`
- `run.resume`
- `run.retry`
- `approval.approve`
- `approval.reject`
- `ping`

主要 Agent event：

- `agent.run.created`
- `agent.context.started`
- `agent.context.completed`
- `agent.intent.detected`
- `agent.plan.created`
- `agent.tool.selected`
- `agent.tool.started`
- `agent.tool.delta`
- `agent.tool.completed`
- `agent.approval.required`
- `agent.response.started`
- `agent.response.delta`
- `agent.response.completed`
- `agent.run.completed`
- `agent.run.failed`
- `agent.run.cancelled`
- `agent.error`

REST 主要承担：

- health/ready/config
- conversations/messages
- runs/events/status-history/tool-calls/model-calls
- approvals
- artifacts/content
- memory
- workflows/skills catalog
- audit logs
- diagnostics/metrics

## 10. skill-sdk 与 skill-runner

### skill-sdk

`skill-sdk` 给技能作者使用，用来开发符合 SunPilot 标准的 skill。

它提供：

- `defineSkill()`
- capability input/output schema 标准
- risk 等级
- `SkillContext`
- testing helper

技能作者依赖 `@sunpilot/skill-sdk`，不需要依赖整个 core。

### skill-runner

`skill-runner` 是 daemon/runtime 侧执行器，负责：

- 扫描技能目录。
- 校验 `skill.json` manifest。
- 检查 manifest 路径不能逃逸技能目录。
- 动态 import skill entry。
- 校验 skill definition 与 manifest 匹配。
- 校验输入输出 Zod schema。
- 执行 capability handler。
- 控制并发、超时、AbortSignal。
- 检查文件、env secret、network、shell 权限。
- 写 artifact、memory、audit、event。

它没有放进 `agent-kernel`，因为 skill execution 是插件运行时能力，不是 Agent Loop 的内部机制。AgentKernel 只决定要不要用工具、用哪个工具；SkillRunner 负责安全执行工具。

## 11. workflow 包

`workflow` 当前代码很少，因为它只是定义层，不是执行层。

核心接口：

```ts
interface BusinessWorkflow {
  id: string;
  title: string;
  version: string;
  description: string;
  match(input, context): Promise<{ score; reason }>;
  plan(input, context): Promise<WorkflowPlan>;
}
```

`WorkflowRegistry` 负责注册、列出、查找 workflow，并把 workflow 转成数据库 record。

Workflow 执行不在 `workflow` 包，而在：

```text
packages/core/src/runtime/runtime.service.ts
```

边界：

```text
skill     = 原子能力
workflow  = 固定业务流程编排
agent     = 动态决策者
```

## 12. web 包

`web` 是 React 前端，当前主页面是 ChatPage。

主要目录：

- `app/`：应用入口、router、providers。
- `layouts/AppShell/`：整体布局、侧边栏、最近对话、用户 footer。
- `pages/ChatPage/`：聊天页面、composer、message list、timeline、approval strip、artifact panel。
- `features/chat/`：WebSocket client 和 chat socket 类型。
- `features/conversations/`：conversation REST API 和模型。
- `features/agent-runtime/`：approval、artifact、event replay 等 Agent runtime REST API。
- `rich-cards/`：富卡片渲染组件。
- `shared/`：API client、hooks、通用组件、类型和工具函数。
- `styles/`：全局样式、tokens、AntD 覆盖。

前端当前链路：

1. 加载 conversation 列表。
2. 用户发送消息。
3. 通过 WebSocket `chat.send` 发给 daemon。
4. 接收 `agent.*` event。
5. 根据 `agent.response.delta` 更新 assistant streaming message。
6. 根据 approval/artifact/tool/model/run events 更新 timeline、approval strip、artifact panel。

## 13. launcher 包

`launcher` 提供本地 CLI：

```text
sun
sunpilot
```

主要职责：

- 启动 daemon。
- 停止 daemon。
- 查看 daemon 状态。
- 打开 Web 页面。
- 查看日志。
- doctor 检查环境。

入口：

```text
packages/launcher/src/index.ts
```

根目录 `scripts/link-sun-bin.mjs` 会在 postinstall 后链接本地命令。

## 14. 典型调用链

### Chat 到 Agent 回复

```text
Web ChatComposer
  -> WebSocket chat.send
  -> daemon JsonRpcRouter
  -> AgentService.handleChatCommand
  -> AgentLoopEngine.run
  -> ContextBuilder
  -> IntentRouter
  -> RuleBasedPlanner
  -> ToolDecisionEngine
  -> PermissionPolicy / Approval
  -> ExecutionOrchestrator / SkillRunner / WorkflowRuntime
  -> ResponseComposer
  -> LLM streamChat
  -> agent.response.delta events
  -> Web MessageList streaming update
```

### Agent 直接执行 Skill

```text
Agent intent requires tool
  -> ToolDecisionEngine selects skill capability
  -> ExecutionOrchestrator records tool call
  -> toolExecutor calls SkillRunner
  -> SkillRunner imports skill and runs handler
  -> artifacts/memory/events/audit persisted
  -> Agent observes result and responds
```

### Agent 启动 Workflow

```text
Agent intent is workflow_execution
  -> ToolDecisionEngine selects workflow.* pseudo skill
  -> composition-root toolExecutor calls SunPilotRuntime.createRun
  -> WorkflowRegistry.get(workflowId)
  -> workflow.plan(input)
  -> runtime creates run/steps/job/events
  -> runtime executes steps via providers/skills
```

### 大模型流式输出

```text
ResponseComposer
  -> llm.streamChat({ messages })
  -> OpenAI-compatible POST /chat/completions stream:true
  -> parse SSE data lines
  -> emit agent.model.delta
  -> emit agent.response.delta
  -> WebSocket pushes to browser
```

## 15. 当前实现特征与注意点

- 当前 Agent skill 匹配仍是 MVP：`IntentRouter` + `candidateSkills` + `INTENT_SKILL_MAP` + enabled skill scan。未来 skill 数量变大时，需要增加 SkillIndex/ToolRetriever，先召回 Top K，再让 LLM 或决策器选择。
- `workflow` 当前是薄定义包，不是执行引擎；执行逻辑在 `core/runtime`。
- `skill-runner` 是插件执行安全边界，不应塞进 `agent-kernel`。
- `protocol` 应保持稳定协议定义，不应引入 core 内部运行时异常类。
- `storage` 的 repository interface 和 Postgres implementation 已经分离，测试用 `InMemoryDatabaseContext` 支撑 core/daemon 快速测试。
- daemon 同时支持旧 runtime/workflow routes 和新 Agent Runtime routes，需要注意状态名、event 名和 cancel/cancelled 语义一致性。
- Web 前端当前是 Chat-first，runtime 的许多 REST 能力已具备，但 UI 只展示对话、timeline、approval、artifact 等核心体验。

## 16. 验证命令

常用全仓验证：

```bash
pnpm -r build
pnpm -r test
pnpm -r lint
```

常用开发命令：

```bash
pnpm dev:daemon
pnpm dev:web
```

本地 PostgreSQL：

```bash
docker compose up -d postgres
```

## 17. 修改入口速查

| 想改什么 | 优先看哪里 |
| --- | --- |
| WebSocket 命令 | `packages/daemon/src/json-rpc-router.ts` |
| REST API | `packages/daemon/src/server.ts` |
| Agent 对外行为 | `packages/core/src/agent/agent.service.ts` |
| Agent 内部循环 | `packages/core/src/agent-kernel/agent-loop-engine.ts` |
| 意图识别 | `packages/core/src/agent-kernel/intent/intent-router.ts` |
| 工具/skill 选择 | `packages/core/src/agent-kernel/tools/tool-decision-engine.ts` |
| 工具执行 | `packages/core/src/agent-kernel/execution/execution-orchestrator.ts` |
| Skill 扫描和执行 | `packages/skill-runner/src/registry.ts`、`packages/skill-runner/src/runner.ts` |
| 写新 skill | `packages/skill-sdk/src/index.ts` |
| Workflow 定义 | `packages/workflow/src/registry.ts` |
| Workflow 执行 | `packages/core/src/runtime/runtime.service.ts` |
| LLM streaming | `packages/core/src/llm/openai-compatible.provider.ts` |
| 数据库接口 | `packages/storage/src/repositories/` |
| Postgres SQL 实现 | `packages/storage/src/postgres/` |
| 数据库 schema | `packages/storage/src/migrations/` |
| Chat 页面 | `packages/web/src/pages/ChatPage/` |
| Web API client | `packages/web/src/features/`、`packages/web/src/shared/api/` |
| CLI | `packages/launcher/src/index.ts` |
