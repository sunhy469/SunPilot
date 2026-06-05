# SunPilot 当前工程实现总结

更新时间：2026-06-05

## 1. 项目定位

SunPilot 是一个 daemon-first 的本地业务 Agent 运行时。当前工程已经形成第一阶段可运行闭环：

- 本机 daemon 监听 `127.0.0.1:3737`。
- Web 前端由 daemon 托管，也可通过 Nginx 反向代理到公网域名。
- 前端与 daemon 之间使用 WebSocket JSON-RPC 通信。
- daemon 与 DeepSeek/OpenAI-compatible 模型服务之间使用 HTTP streaming 拉取增量输出。
- 数据库使用项目 Docker Compose 中的 PostgreSQL，默认映射到 `localhost:5432`。
- 状态、审计、运行事件、消息、artifact 元数据等持久化到 PostgreSQL。
- `sun` launcher 负责启动、停止、查看状态和打开 Web 页面。

当前重点已经从“能跑通”推进到“对话流式体验、Docker 数据库、部署反代、工程验证”。

## 2. 当前运行架构

### 2.1 运行链路

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

### 2.2 本地默认端口

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| daemon | `http://127.0.0.1:3737` | REST、WebSocket、静态 Web |
| Web dev server | `http://127.0.0.1:3738` | Vite 开发模式 |
| PostgreSQL | `localhost:5432` | Docker Compose 暴露端口 |

### 2.3 反向代理

当前 daemon 允许 `tradeagent.asia` 和 `www.tradeagent.asia` 作为可信来源。Nginx 需要保留 WebSocket upgrade 头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;
```

如果 daemon 没有启动，页面会显示 `offline`，浏览器 Network 中 WebSocket 可能保持 pending 或连接失败。当前已经通过前端超时和错误提示避免“无声卡住”。

## 3. Monorepo 包结构

| 包 | 作用 |
| --- | --- |
| `@sunpilot/protocol` | 共享协议类型、运行状态、事件 schema |
| `@sunpilot/storage` | PostgreSQL 存储、迁移、路径、审计、artifact、conversation store |
| `@sunpilot/workflow` | workflow 定义与基础执行抽象 |
| `@sunpilot/skill-sdk` | skill 开发和测试 SDK |
| `@sunpilot/skill-runner` | skill 注册、权限控制、执行器、事件包装 |
| `@sunpilot/core` | runtime service、agent service、LLM provider、业务编排 |
| `@sunpilot/daemon` | Fastify HTTP 服务、WebSocket JSON-RPC、Web 静态资源托管 |
| `@sunpilot/launcher` | `sun` / `sunpilot` 命令行入口 |
| `@sunpilot/web` | React + Ant Design 前端 |
| `tests/integration` | daemon 端到端集成测试 |
| `packages/skills/fixtures/*` | echo/file/shell fixture skills |

## 4. 数据库实现状态

### 4.1 数据库来源

数据库使用 Docker Compose 中的 PostgreSQL：

```bash
docker compose up -d postgres
```

默认连接字符串：

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

如果本机已有 PostgreSQL 占用 `5432`，推荐停止本机 PostgreSQL 服务，让 Docker PostgreSQL 使用默认端口。也可以改端口：

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

### 4.2 当前机器状态

本机 PostgreSQL 服务已移除/停止，数据库由 Docker 容器提供。当前验证过：

```bash
docker compose ps postgres
```

容器 `sunpilot-postgres` 为 healthy，并映射 `0.0.0.0:5432->5432/tcp`。

### 4.3 存储能力

`@sunpilot/storage` 当前负责：

- PostgreSQL 连接配置。
- 数据库 schema migration。
- migration advisory lock，避免并发迁移互相踩踏。
- runtime run/job/step 状态。
- append-only event log。
- audit log。
- conversation/message。
- artifact 元数据。
- 本地 runtime 路径、token、pid、日志路径。

## 5. daemon 和 API

### 5.1 HTTP

daemon 使用 Fastify，主要能力：

- `/healthz`：健康检查。
- `/readyz`：可用性检查。
- `/v1/runs`：创建 workflow run。
- `/v1/conversations`：conversation 列表/创建。
- `/v1/conversations/:id/messages`：消息列表。
- 静态托管 `packages/web/dist`。

### 5.2 WebSocket JSON-RPC

WebSocket 入口：

```text
/v1/ws?token=<runtime token>
```

鉴权 token 来自：

```bash
~/.sunpilot/runtime/auth-token
```

当前支持的主要 method：

| method | 用途 |
| --- | --- |
| `ping` | WS 连通性测试 |
| `chat.send` | 发送对话消息 |
| `chat.stop` | 停止聊天占位接口 |
| `conversation.subscribe` | 订阅 conversation |
| `conversation.unsubscribe` | 取消订阅 |
| `run.create` | 创建 runtime run |
| `run.subscribe` | 订阅 run event |
| `run.unsubscribe` | 取消订阅 |

聊天相关推送事件：

| event | 说明 |
| --- | --- |
| `chat.message.created` | 用户消息已创建 |
| `chat.assistant.started` | assistant 消息占位开始 |
| `chat.assistant.delta` | assistant 增量文本 |
| `chat.assistant.completed` | assistant 完整消息落库完成 |
| `chat.error` | 聊天请求失败，前端结束 pending 并展示错误 |

## 6. DeepSeek 流式输出实现

### 6.1 设计结论

项目使用两段流式链路：

```text
DeepSeek -> daemon: HTTP streaming
daemon -> browser: WebSocket JSON-RPC event
```

也就是说，前端不直接连 DeepSeek，前端只维护与 daemon 的 WebSocket。daemon 从 DeepSeek 收到一段 delta，就立刻通过 WebSocket 发 `chat.assistant.delta` 给前端。

### 6.2 core LLM provider

`@sunpilot/core` 中 LLM provider 当前只保留流式接口：

```ts
streamChat(request): AsyncIterable<ChatCompletionDelta>
```

OpenAI-compatible provider 请求体使用：

```json
{
  "stream": true
}
```

provider 从 response body 中解析 SSE 格式的 `data:` 行，遇到 `[DONE]` 结束。每个 chunk 提取 `choices[0].delta.content` 并 yield。

### 6.3 agent service

`AgentService.chat` 当前流程：

1. 创建用户消息并回调 `onUserMessage`。
2. 读取 conversation history。
3. 创建 assistant message id。
4. 回调 `onAssistantStarted`，让前端先出现空 assistant 气泡。
5. 遍历 `llm.streamChat`。
6. 每个 delta 累加到 `assistantContent`，并回调 `onAssistantDelta`。
7. 流结束后把完整 assistant 消息落库。
8. 回调 `onAssistantMessage`。

### 6.4 前端展示效果

前端收到 `chat.assistant.started` 后创建空 assistant 消息；收到每个 `chat.assistant.delta` 后将 delta append 到该消息内容。因此页面效果是逐段/逐 token 展示，而不是等待模型完整回答后一次性显示。

实际粒度取决于 DeepSeek 返回的 chunk；通常接近 token 级，但不能保证每次一定是单个字符。

## 7. 前端实现状态

### 7.1 技术栈

- React 19。
- React Router 7。
- Ant Design 6。
- Vite 6。
- Vitest + Testing Library。

### 7.2 页面

当前主要页面：

- Chat。
- Runs。
- Artifacts。
- Memory。
- Settings。

默认首页为 Chat。Chat 页面保持 eager import，保证首屏对话体验；其它页面使用 `React.lazy` 和 `Suspense` 懒加载。

### 7.3 WebSocket 体验修复

`useChat` 当前已经处理：

- 发送消息后立即进入 `thinking`。
- WebSocket 打开超时：10 秒。
- 聊天响应超时：90 秒。
- socket `error` / `close` 时结束 pending。
- JSON-RPC error 和 `chat.error` 都会展示错误。
- 收到 delta 时刷新响应超时计时器。
- 组件卸载时关闭 socket 和清理 timer。

这样即使 daemon 没启动、Nginx 代理异常、模型 API key 缺失、模型请求失败，前端也不会无限 pending。

### 7.4 构建拆包

此前 Vite 提示部分 chunk 超过 500 kB。当前通过：

- `rollupOptions.output.manualChunks`
- 非 Chat 页面动态 import

拆出：

- `react-*` chunk。
- `antd-*` chunk。
- 小型 route chunk。

最近一次构建结果：

```text
react chunk: 约 285 kB
antd chunk: 约 346 kB
```

500 kB warning 已消失。

## 8. launcher 实现状态

`@sunpilot/launcher` 提供：

```bash
sun start
sun stop
sun status
sun open
```

当前行为：

- `sun start` 检查 daemon 是否可达，不可达则后台启动 daemon。
- `sun stop` 根据 pid/runtime 信息停止 daemon。
- `sun status` 查看运行状态。
- `sun open` 默认打开 `https://tradeagent.asia`，可通过 `SUNPILOT_WEB_URL` 覆盖。
- launcher 已处理 stale pid 清理，避免旧 pid 文件导致误判。

## 9. runtime / workflow / skill

### 9.1 runtime

runtime service 当前负责：

- 创建 run/job/step。
- 执行 workflow。
- 写入 append-only event。
- 写入 audit log。
- artifact 记录。
- approval 等待态处理。

approval 相关逻辑已修正：

- step 已处于 `waiting_approval` 时不会重复生成新的 pending approval。
- run/job 会保持 waiting 状态。
- 避免重复请求审批造成状态混乱。

### 9.2 skill-runner

skill-runner 当前具备：

- skill registry。
- fixture skill。
- 权限控制。
- secret/env 限制。
- shell/file/helper 调用。
- custom event protocol-safe 包装。

custom event 现在会包装成协议可接受的数据结构，避免任意 payload 破坏事件 schema。

## 10. 环境变量

核心环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUNPILOT_DATABASE_URL` | `postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot` | PostgreSQL 连接 |
| `SUNPILOT_LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API base |
| `SUNPILOT_LLM_MODEL` | `deepseek-v4-flash` | 默认模型 |
| `SUNPILOT_LLM_API_KEY` | 无 | 模型 API key |
| `DEEPSEEK_API_KEY` | 无 | 备用 API key 名 |
| `SUNPILOT_WEB_URL` | `https://tradeagent.asia` | `sun open` 打开地址 |

API key 不应写入仓库。推荐放到 shell profile、systemd environment、进程管理器环境变量或部署环境变量中。

## 11. 当前验证结果

最近一次完整验证：

```bash
pnpm build
pnpm test
pnpm lint
```

结果：

- build 通过。
- test 通过。
- lint 通过。
- integration tests 通过。
- Vite 500 kB chunk warning 已消失。
- Docker PostgreSQL healthy。
- daemon healthz 返回 alive。
- WebSocket `ping` 返回 `{"ok": true}`。
- 页面发送消息后流式展示已验证成功。

健康检查：

```bash
curl http://127.0.0.1:3737/healthz
```

WS ping 示例：

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
node --input-type=module -e 'const ws=new WebSocket(`ws://127.0.0.1:3737/v1/ws?token=${process.env.TOKEN}`); ws.addEventListener("open",()=>ws.send(JSON.stringify({jsonrpc:"2.0",id:"ping_1",method:"ping",params:{}}))); ws.addEventListener("message",(event)=>{ console.log(String(event.data)); ws.close(); });'
```

运行时注意：上面的示例需要把 `TOKEN` 传给 node 进程环境，例如：

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token) node --input-type=module -e '...'
```

## 12. 常见故障判断

### 12.1 页面显示 offline

优先检查 daemon：

```bash
curl http://127.0.0.1:3737/healthz
sun status
```

如果 daemon 没启动：

```bash
sun start
```

### 12.2 WebSocket pending 或无响应

判断顺序：

1. daemon 是否监听 `3737`。
2. Nginx 是否配置 Upgrade/Connection。
3. token 是否正确。
4. 浏览器访问域名是否被 daemon 允许为 trusted origin。
5. daemon 日志是否有模型请求错误。

### 12.3 用户消息发出后没有 assistant 内容

优先检查：

- `SUNPILOT_LLM_API_KEY` 或 `DEEPSEEK_API_KEY` 是否设置。
- `SUNPILOT_LLM_BASE_URL` 是否正确。
- `SUNPILOT_LLM_MODEL` 是否是实际可用模型。
- daemon 日志中是否有 `LLM request failed`。

当前前端会在失败时结束 pending 并展示错误，不再无限等待。

### 12.4 数据库连接失败

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

## 13. 当前代码改动状态

当前工作区包含未提交的功能改动，主要是：

- DeepSeek/OpenAI-compatible 对话改为纯流式输出。
- agent service 改为消费 `streamChat` 并推送 delta。
- daemon 通过 WebSocket 推送 `chat.assistant.delta` 和 `chat.error`。
- 前端 Chat 页面支持流式增量展示、超时和错误处理。
- Vite 构建拆包优化。
- 对应单元测试和集成测试更新。

`developer_docs/dev_docs/` 目录被 `.gitignore` 忽略，因此本文档默认是本地开发总结，不会自动进入 git 提交。

## 14. 后续建议

短期建议：

- 为 `chat.stop` 接入真正的 abort controller，支持用户中断 DeepSeek streaming。
- 将 daemon 日志中的聊天错误在 Web UI 中做更友好的提示映射。
- 为 WebSocket 增加心跳保活和自动重连策略。
- 增加前端对 `chat.error` 的专项测试。
- 增加生产环境 systemd 配置，确保服务器重启后 daemon 自动恢复。

中期建议：

- 增加 conversation 订阅的真实增量同步。
- 增加 artifact 下载/预览能力。
- 增加 skill marketplace 或本地 skill 管理页面。
- 增加 migration 版本可视化和数据库诊断命令。
- 对大依赖继续做按页面/按组件拆包。

## 15. 当前一句话结论

SunPilot 当前已经具备 Docker PostgreSQL + daemon + WebSocket + DeepSeek streaming + React Web 的完整对话闭环；页面发送消息后可以通过 WebSocket 接收 daemon 转发的模型增量输出，实现逐段流式展示。当前主要剩余工作是生产级进程守护、流式中断、错误体验细化和更多业务能力扩展。
