# SunPilot 命令使用手册

本文档使用中文说明当前 SunPilot 项目已经实现的命令、常用环境变量、API 调试方式和开发验证命令。

更新时间：2026-06-05

## 1. 基础要求

当前项目是 pnpm monorepo。

- Node.js：`>=22.22.2 <23`
- pnpm：`>=11.5.1 <12`
- Docker / Docker Compose：用于本地 PostgreSQL
- daemon 默认地址：`http://127.0.0.1:3737`
- Web dev server 默认地址：`http://127.0.0.1:3738`
- 默认运行数据目录：`~/.sunpilot`

## 2. 安装、数据库和构建

首次进入项目目录后执行：

```bash
pnpm install
docker compose up -d postgres
pnpm build
```

默认数据库连接为：

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

如果宿主机已有 PostgreSQL 或其他服务占用 `5432`，可以改用其他映射端口：

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

`pnpm install` 会执行根目录 `postinstall`：

```bash
node scripts/link-sun-bin.mjs
```

它会把当前项目 launcher 链接到：

```bash
~/.local/bin/sun
```

确保 `~/.local/bin` 在 `PATH` 中：

```bash
echo $PATH | tr ':' '\n' | grep "$HOME/.local/bin"
```

## 3. `sun` CLI

当前 `sun` 是 daemon 生命周期管理入口，不是终端聊天入口。

### 3.1 启动 daemon

```bash
sun start
```

行为：

- 先访问 `/healthz` 判断 daemon 是否已经在线。
- daemon 在线时直接输出健康状态。
- daemon 不在线时后台启动 `@sunpilot/daemon`。
- 默认监听 `127.0.0.1:3737`。
- 后台进程继承当前 shell 环境变量。

前台调试：

```bash
sun start --foreground
```

指定端口：

```bash
sun start --port 3738
```

也可以使用环境变量：

```bash
export SUNPILOT_PORT=3738
sun start
```

### 3.2 查看状态

```bash
sun status
```

示例输出：

```json
{
  "ok": true,
  "product": "SunPilot",
  "daemon": "alive"
}
```

指定端口：

```bash
sun status --port 3738
```

### 3.3 打开 Web 页面

```bash
sun open
```

默认打开：

```text
https://tradeagent.asia/
```

本地开发时可以覆盖：

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

`SUNPILOT_CONSOLE_URL` 是旧变量名，仅在 `SUNPILOT_WEB_URL` 未设置时作为 fallback。

### 3.4 停止 daemon

```bash
sun stop
```

行为：

- 读取 `~/.sunpilot/runtime/daemon.pid`。
- 对记录进程发送 `SIGTERM`。
- 删除 pid 文件。

## 4. Web 与聊天入口

当前 Web 产品是 Chat-first 页面：

- `/`、`/chat` 和未知路径都会进入 `ChatPage`。
- 侧边栏展示历史 conversations。
- 插件入口当前显示空状态页面。
- Chat 通过 `/v1/ws` 使用 WebSocket JSON-RPC。
- local token 验证在当前测试阶段关闭，历史 URL 中的 `?token=...` 会由前端移除。

终端命令 `sun chat`、`sun ask` 尚未实现。自然语言对话请使用 Web 页面。

## 5. LLM 配置

当前 LLM provider 是 OpenAI-compatible，默认指向 DeepSeek。

推荐配置：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
```

也支持备用密钥变量名：

```bash
export DEEPSEEK_API_KEY=你的密钥
```

只检查密钥长度，避免泄露明文：

```bash
node -e "const k=process.env.SUNPILOT_LLM_API_KEY||process.env.DEEPSEEK_API_KEY; console.log(k ? 'API key is set, length=' + k.length : 'API key is not set')"
```

让后台 daemon 读取新变量：

```bash
sun stop
sun start
```

## 6. 长期保存环境变量

可以写入当前用户的 `~/.bashrc`：

```bash
nano ~/.bashrc
```

追加：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

生效：

```bash
source ~/.bashrc
sun stop
sun start
```

不要把 API key 写进仓库文件。

## 7. API 调试命令

健康检查：

```bash
curl http://127.0.0.1:3737/healthz
```

就绪检查：

```bash
curl http://127.0.0.1:3737/readyz
```

conversation 列表：

```bash
curl http://127.0.0.1:3737/v1/conversations
```

创建 conversation：

```bash
curl -X POST http://127.0.0.1:3737/v1/conversations \
  -H "Content-Type: application/json" \
  -d '{"title":"测试对话"}'
```

HTTP chat：

```bash
curl -X POST http://127.0.0.1:3737/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话介绍 SunPilot"}'
```

WebSocket ping：

```bash
node --input-type=module -e 'const ws=new WebSocket("ws://127.0.0.1:3737/v1/ws"); ws.addEventListener("open",()=>ws.send(JSON.stringify({jsonrpc:"2.0",id:"ping_1",method:"ping",params:{}}))); ws.addEventListener("message",(event)=>{ console.log(String(event.data)); ws.close(); });'
```

## 8. 域名访问

当前默认公网域名：

```text
https://tradeagent.asia
```

daemon 默认信任：

```text
https://tradeagent.asia
https://www.tradeagent.asia
```

如需增加额外域名：

```bash
export SUNPILOT_ALLOWED_ORIGINS=https://example.com,https://www.example.com
sun stop
sun start
```

Nginx 需要保留 WebSocket upgrade：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;
```

## 9. 开发与验证命令

全量构建：

```bash
pnpm build
```

全量测试：

```bash
pnpm test
```

全量 lint：

```bash
pnpm lint
```

单包命令：

```bash
pnpm --filter @sunpilot/core test
pnpm --filter @sunpilot/daemon build
pnpm --filter @sunpilot/web test
pnpm --filter @sunpilot/launcher test
pnpm --filter @sunpilot/integration-tests test
```

开发服务：

```bash
pnpm dev:daemon
pnpm dev:web
```
