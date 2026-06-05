# SunPilot 当前工程实现总结

本文档使用中文总结当前 SunPilot 工程实现状态。该文件位于 `developer_docs/dev_docs/`，当前被 `.gitignore` 忽略，默认作为本地开发记录。

更新时间：2026-06-05

## 1. 项目定位

SunPilot 是 daemon-first 的本地业务 Agent 运行时。当前工程已经形成可运行闭环：

- 本机 daemon 监听 `127.0.0.1:3737`。
- daemon 托管构建后的 React Web 页面。
- Web 当前是 Chat-first 产品界面，主入口为 `/` 和 `/chat`。
- 前端与 daemon 使用 WebSocket JSON-RPC 通信。
- daemon 与 DeepSeek/OpenAI-compatible 模型服务使用 HTTP streaming。
- PostgreSQL 由项目 Docker Compose 提供，默认映射到 `localhost:5432`。
- conversations、messages、runs、events、artifacts、audit logs 等持久化到 PostgreSQL。
- `sun` launcher 负责启动、停止、查看状态和打开 Web 页面。

当前重点是“本地 daemon + Docker PostgreSQL + WebSocket streaming chat + React Web”的端到端体验。

## 2. 当前运行架构

```text
Browser
  |
  | HTTPS / WebSocket
  v
Nginx: tradeagent.asia
  |
  | proxy_pass http://127.0.0.1:3737
  v
SunPilot daemon
  |
  | PostgreSQL protocol
  v
Docker PostgreSQL

SunPilot daemon
  |
  | OpenAI-compatible HTTP streaming
  v
DeepSeek
```

本地默认端口：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| daemon | `http://127.0.0.1:3737` | REST、WebSocket、静态 Web |
| Web dev server | `http://127.0.0.1:3738` | Vite 开发模式 |
| PostgreSQL | `localhost:5432` | Docker Compose 暴露端口 |

## 3. Monorepo 包结构

| 包 | 作用 |
| --- | --- |
| `@sunpilot/protocol` | 共享协议类型、运行状态、事件 schema |
| `@sunpilot/storage` | PostgreSQL 存储、迁移、路径、审计、artifact、conversation/message store |
| `@sunpilot/workflow` | workflow 定义与 registry |
| `@sunpilot/skill-sdk` | skill 开发和测试 SDK |
| `@sunpilot/skill-runner` | skill 注册、权限控制、执行器、事件包装 |
| `@sunpilot/core` | runtime service、agent service、LLM provider、业务编排 |
| `@sunpilot/daemon` | Fastify HTTP 服务、WebSocket JSON-RPC、Web 静态资源托管 |
| `@sunpilot/launcher` | `sun` / `sunpilot` 命令行入口 |
| `@sunpilot/web` | React + Ant Design Chat-first 前端 |
| `tests/integration` | daemon 端到端集成测试 |

## 4. 数据库实现状态

数据库使用 Docker Compose PostgreSQL：

```bash
docker compose up -d postgres
```

默认连接字符串：

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

如果本机已有服务占用 `5432`：

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

`@sunpilot/storage` 当前负责：

- PostgreSQL 连接配置。
- SQL migration。
- migration advisory lock。
- conversation / message repository。
- runtime run / job / step 状态。
- append-only event log。
- audit log。
- artifact 元数据。
- memory / skill / workflow catalog。
- 本地 runtime 路径、pid、日志路径。

SQLite 不再作为主数据库 fallback。

## 5. daemon 和 API

daemon 使用 Fastify。

基础接口：

| 接口 | 说明 |
| --- | --- |
| `GET /healthz` | 健康检查 |
| `GET /readyz` | 可用性检查，返回数据库、配置、stub storage、skill/workflow 数量 |
| `GET /v1/config` | 读取本地配置 |
| `PATCH /v1/config` | 更新本地配置并写 audit |

Chat / conversation：

| 接口 | 说明 |
| --- | --- |
| `POST /v1/chat` | HTTP chat 调用 |
| `GET /v1/conversations` | conversation 列表 |
| `POST /v1/conversations` | 创建 conversation |
| `GET /v1/conversations/:id/messages` | conversation messages |
| `DELETE /v1/conversations/:id` | 删除 conversation |

Runtime / workflow / skill：

| 接口 | 说明 |
| --- | --- |
| `POST /v1/runs` | 创建 workflow run |
| `GET /v1/runs` | run 列表 |
| `GET /v1/runs/:id` | run 详情，包含 steps/events/artifacts/memory |
| `GET /v1/runs/:id/events` | run events |
| `POST /v1/runs/:id/interrupt` | 中断 run |
| `POST /v1/runs/:id/cancel` | 取消 run |
| `POST /v1/runs/:id/retry` | 重试 run |
| `GET /v1/workflows` | workflow catalog |
| `POST /v1/workflows/reload` | 重载 workflow catalog |
| `GET /v1/skills` | skill catalog |
| `POST /v1/skills/reload` | 重载 skills |
| `POST /v1/skills/:id/enable` | 启用 skill |
| `POST /v1/skills/:id/disable` | 禁用 skill |

其他运行数据：

| 接口 | 说明 |
| --- | --- |
| `GET /v1/approvals` | approval 列表 |
| `POST /v1/approvals/:id/approve` | 通过 approval |
| `POST /v1/approvals/:id/reject` | 拒绝 approval |
| `GET /v1/artifacts` | artifact 列表 |
| `GET /v1/artifacts/:id/content` | artifact 内容 |
| `GET /v1/audit-logs` | audit log |
| `GET /v1/jobs` | job 列表 |
| `POST /v1/jobs/expire-timeouts` | 处理超时 job |
| `GET /v1/capabilities` | runtime capability 列表 |
| `GET /v1/memory` | memory 列表 |

## 6. WebSocket JSON-RPC

WebSocket 入口：

```text
/v1/ws
```

当前测试阶段已关闭本地 token 验证，WS 连接不需要 query token。

主要 method：

| method | 用途 |
| --- | --- |
| `ping` | WS 连通性测试，返回 `pong` notification |
| `chat.send` | 发送对话消息 |
| `chat.stop` | 停止聊天占位接口，当前只返回 `{ stopped: true }` |
| `conversation.subscribe` | conversation 订阅占位接口 |
| `conversation.unsubscribe` | conversation 取消订阅占位接口 |
| `run.create` | 创建 runtime run |
| `run.subscribe` | 订阅 run event |
| `run.unsubscribe` | 取消订阅 run event |

聊天推送事件：

| event | 说明 |
| --- | --- |
| `chat.message.created` | 用户消息已创建 |
| `chat.assistant.started` | assistant 消息占位开始 |
| `chat.assistant.delta` | assistant 增量文本 |
| `chat.assistant.completed` | assistant 完整消息落库完成 |
| `chat.error` | 聊天请求失败，前端结束 pending 并展示错误 |

daemon 对 WebSocket 有 60 秒 idle timeout。前端每 25 秒发送一次 `ping` 保活。

## 7. DeepSeek / OpenAI-compatible 流式输出

项目使用两段流式链路：

```text
DeepSeek -> daemon: HTTP streaming
daemon -> browser: WebSocket JSON-RPC event
```

`@sunpilot/core` 中 LLM provider 使用：

```ts
streamChat(request): AsyncIterable<ChatCompletionDelta>
```

OpenAI-compatible 请求体包含：

```json
{
  "stream": true
}
```

provider 从 response body 解析 SSE `data:` 行，遇到 `[DONE]` 结束，并提取 `choices[0].delta.content`。

`AgentService.chat` 当前流程：

1. 解析 chat request。
2. 获取或创建 conversation。
3. 创建用户消息，并触发 `onUserMessage`。
4. 读取 conversation history。
5. 创建 assistant message id，并触发 `onAssistantStarted`。
6. 遍历 `llm.streamChat`。
7. 每个 delta 累加到 assistant content，并触发 `onAssistantDelta`。
8. 流结束后把完整 assistant 消息落库。
9. 触发 `onAssistantMessage` 并返回 conversation id 和 assistant message。

## 8. 前端实现状态

技术栈：

- React 19
- React Router 7
- Ant Design 6
- Vite 6
- Vitest + Testing Library

当前页面：

- `/`：ChatPage
- `/chat`：ChatPage
- `*`：ChatPage fallback

当前保留的页面目录只有：

```text
packages/web/src/pages/ChatPage/
```

此前 Runs、Artifacts、Memory、Settings 页面已从当前工作区移除；对应 runtime API 仍然在 daemon 中存在。

Chat 页面能力：

- conversation 侧边栏。
- 新建对话。
- 历史 conversation 选择。
- WebSocket streaming assistant delta 展示。
- offline banner。
- error card。
- stop 按钮发送 `chat.stop`。
- 插件入口当前展示空状态。

`useChat` 当前处理：

- 发送消息后进入 pending / thinking。
- WebSocket 打开超时：10 秒。
- 聊天响应超时：90 秒。
- socket `error` / `close` 时结束 pending。
- JSON-RPC error 和 `chat.error` 展示错误。
- 收到 delta 时刷新响应超时计时器。
- 组件卸载时关闭 socket 和清理 timer。
- 每 25 秒发送 `ping` 保持 WS 活动。

## 9. launcher 实现状态

`@sunpilot/launcher` 提供：

```bash
sun start
sun stop
sun status
sun open
```

当前行为：

- `sun start` 先检查 daemon 是否可达，不可达则后台启动 daemon。
- `sun start --foreground` 前台运行 daemon，便于看日志。
- `sun start --port <port>` 指定端口。
- `sun stop` 根据 `~/.sunpilot/runtime/daemon.pid` 停止 daemon。
- `sun status` 查看 `/healthz`。
- `sun open` 默认打开 `https://tradeagent.asia`，可通过 `SUNPILOT_WEB_URL` 覆盖。

尚未实现：

- `sun chat`
- `sun ask`
- 生产级服务安装命令

## 10. runtime / workflow / skill

runtime service 当前负责：

- 创建 run/job/step。
- 执行 workflow。
- 写入 append-only event。
- 写入 audit log。
- artifact 记录。
- approval 等待态处理。
- run interrupt/cancel/retry。

skill-runner 当前具备：

- skill registry。
- 用户本地 skill 加载。
- 权限控制。
- secret/env 限制。
- shell/file/helper 调用。
- custom event protocol-safe 包装。
- 超时和并发控制。

## 11. 环境变量

核心环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUNPILOT_DATABASE_URL` | `postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot` | PostgreSQL 连接 |
| `SUNPILOT_DATABASE_PROVIDER` | `postgres` | 数据库类型，当前只支持 PostgreSQL |
| `SUNPILOT_LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API base |
| `SUNPILOT_LLM_MODEL` | `deepseek-v4-flash` | 默认模型 |
| `SUNPILOT_LLM_API_KEY` | 无 | 模型 API key |
| `DEEPSEEK_API_KEY` | 无 | 备用 API key 名 |
| `SUNPILOT_WEB_URL` | `https://tradeagent.asia` | `sun open` 打开地址 |
| `SUNPILOT_ALLOWED_ORIGINS` | 空 | 追加允许的外部 Origin |

API key 不应写入仓库。推荐放到 shell profile、systemd environment、进程管理器环境变量或部署环境变量中。

## 12. 当前验证命令

推荐完整验证：

```bash
pnpm build
pnpm test
pnpm lint
```

健康检查：

```bash
curl http://127.0.0.1:3737/healthz
```

就绪检查：

```bash
curl http://127.0.0.1:3737/readyz
```

WebSocket ping：

```bash
node --input-type=module -e 'const ws=new WebSocket("ws://127.0.0.1:3737/v1/ws"); ws.addEventListener("open",()=>ws.send(JSON.stringify({jsonrpc:"2.0",id:"ping_1",method:"ping",params:{}}))); ws.addEventListener("message",(event)=>{ console.log(String(event.data)); ws.close(); });'
```

HTTP chat：

```bash
curl -X POST http://127.0.0.1:3737/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话介绍 SunPilot"}'
```

## 13. 常见故障判断

### 13.1 页面显示 offline

检查 daemon：

```bash
curl http://127.0.0.1:3737/healthz
sun status
```

如果 daemon 没启动：

```bash
sun start
```

### 13.2 WebSocket pending 或连接失败

判断顺序：

1. daemon 是否监听 `3737`。
2. Nginx 是否配置 `Upgrade` / `Connection`。
3. 浏览器访问 Origin 是否被 daemon 允许。
4. 前端访问地址和后端代理是否一致。
5. daemon 日志是否有模型请求错误。

### 13.3 用户消息发出后没有 assistant 内容

优先检查：

- `SUNPILOT_LLM_API_KEY` 或 `DEEPSEEK_API_KEY` 是否设置。
- `SUNPILOT_LLM_BASE_URL` 是否正确。
- `SUNPILOT_LLM_MODEL` 是否是实际可用模型。
- daemon 日志中是否有 `LLM request failed`。

当前前端会在失败时结束 pending 并展示错误。

### 13.4 数据库连接失败

检查 Docker PostgreSQL：

```bash
docker compose ps postgres
docker compose logs postgres
```

检查端口：

```bash
ss -ltnp | grep 5432
```

如果本机 PostgreSQL 抢占 `5432`，停止本机服务或改 Docker 映射端口。

## 14. 当前代码改动状态

当前工作区包含未提交改动，主要方向是：

- Web 从多页面控制台收敛到 Chat-first 界面。
- 删除/移除 Runs、Artifacts、Memory、Settings 页面目录。
- Chat 页面支持 conversation 侧边栏和插件空状态入口。
- WebSocket chat 支持 streaming delta、错误提示、超时、ping 保活和 stop 按钮。
- daemon 保留 runtime、workflow、skill、artifact、approval、audit API。

这部分改动来自当前工作区状态，提交前需要结合 `git status` 和测试结果确认。

## 15. 后续建议

短期建议：

- 为 `chat.stop` 接入真正的 abort controller，支持用户中断 LLM streaming。
- 为插件入口接入真实 skill/plugin catalog。
- 增加 WebSocket 自动重连策略。
- 增加前端对 `chat.error`、offline、stop 的专项测试。
- 增加生产环境 systemd 配置，确保服务器重启后 daemon 自动恢复。

中期建议：

- 增加 conversation 订阅的真实增量同步。
- 增加 artifact 下载/预览 UI。
- 增加 run/workflow/approval 的 Web 管理界面或诊断页。
- 增加 migration 版本可视化和数据库诊断命令。
- 对大依赖继续做按页面/按组件拆包。

## 16. 当前一句话结论

SunPilot 当前已经具备 Docker PostgreSQL + daemon + WebSocket + DeepSeek/OpenAI-compatible streaming + React Chat-first Web 的完整对话闭环；主要剩余工作是生产级进程守护、流式中断、插件入口真实数据接入和更多业务运行管理界面。
