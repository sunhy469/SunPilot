# SunPilot 命令使用手册

本文档汇总当前 SunPilot 项目已经实现的终端命令、环境变量、服务访问方式和常用测试命令。

## 1. 基础要求

当前项目使用 pnpm monorepo。

运行环境：

- Node.js：`>=22.22.2 <23`
- pnpm：`>=11.5.1 <12`
- 默认服务端口：`3737`
- 默认本地数据目录：`~/.sunpilot`

## 2. 安装与构建

首次进入项目目录后执行：

```bash
pnpm install
pnpm build
```

`pnpm install` 会自动执行根目录 `postinstall` 脚本：

```bash
node scripts/link-sun-bin.mjs
```

该脚本会把当前项目的 launcher 链接为：

```bash
~/.local/bin/sun
```

因此构建后可以直接使用：

```bash
sun start
sun status
sun open
sun stop
```

不需要再执行 `pnpm setup:sun`，也不需要使用 `pnpm -- ...` 形式。

## 3. sun CLI 已实现指令

当前 `sun` 命令是服务管理入口，不是聊天入口。

### 3.1 启动守护进程

```bash
sun start
```

行为：

- 先请求 `http://127.0.0.1:3737/healthz` 检查 daemon 是否已在线。
- 如果 daemon 已在线，输出健康状态。
- 如果 daemon 不在线，后台启动 `@sunpilot/daemon`。
- 默认监听 `127.0.0.1:3737`。
- 子进程会继承当前 shell 的环境变量。

常见输出：

```text
SunPilot daemon is not reachable.
SunPilot daemon starting at http://127.0.0.1:3737
```

### 3.2 查看状态

```bash
sun status
```

行为：

- 请求 daemon 的 `/healthz`。
- daemon 在线时返回 JSON。
- daemon 不在线时输出 `SunPilot daemon is not reachable.`。

示例输出：

```json
{
  "ok": true,
  "product": "SunPilot",
  "daemon": "alive"
}
```

### 3.3 打开控制台

```bash
sun open
```

行为：

- 读取或生成本地访问 token。
- 默认生成公网控制台地址：

```text
https://tradeagent.asia/?token=...
```

- 如果服务器没有图形界面，无法自动打开浏览器，会输出：

```text
Browser open is not available on this machine.
Opened https://tradeagent.asia/?token=...
```

此时复制完整 URL 到本地浏览器即可。

### 3.4 停止守护进程

```bash
sun stop
```

行为：

- 读取 `~/.sunpilot/runtime/daemon.pid`。
- 对记录的进程发送 `SIGTERM`。
- 删除 pid 文件。

常见输出：

```text
SunPilot daemon stop signal sent.
```

如果 pid 文件不存在：

```text
SunPilot daemon pid file was not found.
```

## 4. 可选参数

### 4.1 指定端口

```bash
sun start --port 3738
sun status --port 3738
sun open --port 3738
```

也可以通过环境变量指定：

```bash
export SUNPILOT_PORT=3738
sun start
```

### 4.2 前台运行 daemon

```bash
sun start --foreground
```

用途：

- 调试 daemon 日志。
- 观察启动失败原因。
- 让进程跟随当前终端退出。

### 4.3 覆盖控制台访问域名

`sun open` 默认使用：

```bash
https://tradeagent.asia
```

如需临时改成本地地址：

```bash
export SUNPILOT_CONSOLE_URL=http://127.0.0.1:3737
sun open
```

## 5. Token 与网页登录

daemon 的 API 默认需要本地 token。

token 文件位置：

```bash
~/.sunpilot/runtime/auth-token
```

查看 token：

```bash
cat ~/.sunpilot/runtime/auth-token
```

手动生成网页登录 URL：

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
echo "https://tradeagent.asia/?token=$TOKEN"
```

网页第一次带 token 打开后，会把 token 保存到浏览器 localStorage。之后可以直接访问：

```text
https://tradeagent.asia
```

如果浏览器清理了 localStorage，重新用带 token 的 URL 打开即可。

## 6. DeepSeek / OpenAI-compatible 模型环境变量

当前 agent core 已接入 OpenAI-compatible LLM provider，默认指向 DeepSeek。

推荐环境变量：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
```

也支持备用密钥变量名：

```bash
export DEEPSEEK_API_KEY=你的密钥
```

查看是否已设置：

```bash
echo $SUNPILOT_LLM_BASE_URL
echo $SUNPILOT_LLM_MODEL
echo ${#SUNPILOT_LLM_API_KEY}
```

只显示密钥长度，避免泄露：

```bash
node -e "const k=process.env.SUNPILOT_LLM_API_KEY||process.env.DEEPSEEK_API_KEY; console.log(k ? 'API key is set, length=' + k.length : 'API key is not set')"
```

让 daemon 读取新环境变量：

```bash
sun stop
sun start
```

注意：daemon 是由 `sun start` 启动的后台进程，它只能继承启动它的 shell 环境变量。

## 7. 长期保存环境变量

可以写入当前用户的 `~/.bashrc`：

```bash
nano ~/.bashrc
```

追加：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
```

生效：

```bash
source ~/.bashrc
sun stop
sun start
```

不要把 API key 写进仓库文件。

## 8. API 调试命令

### 8.1 健康检查

```bash
curl http://127.0.0.1:3737/healthz
```

### 8.2 就绪检查

```bash
curl http://127.0.0.1:3737/readyz
```

### 8.3 带 token 调用 API

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3737/v1/workflows
```

### 8.4 创建 fixture workflow 运行

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
curl -X POST http://127.0.0.1:3737/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"text":"run fixture echo workflow"},"workflowId":"fixture.echo"}'
```

## 9. 域名访问

当前域名：

```text
https://tradeagent.asia
```

Nginx 已配置为反向代理到：

```text
http://127.0.0.1:3737
```

daemon 默认信任以下外部 Origin：

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

## 10. 开发与验证命令

### 10.1 全量构建

```bash
pnpm build
```

### 10.2 全量测试

```bash
pnpm test
```

### 10.3 全量 lint

```bash
pnpm lint
```

### 10.4 单包测试

```bash
pnpm --filter @sunpilot/core test
pnpm --filter @sunpilot/daemon build
pnpm --filter @sunpilot/console test
pnpm --filter @sunpilot/launcher test
pnpm --filter @sunpilot/integration-tests test
```

### 10.5 单包开发服务

```bash
pnpm dev:daemon
pnpm dev:console
```

## 11. 当前尚未实现的命令

当前尚未实现自然语言对话命令：

```bash
sun chat
```

也尚未实现类似下面的直接问答形式：

```bash
sun ask "帮我分析这个客户是否值得跟进"
```

目前网页控制台是“运行监控台”，可以创建 fixture 工作流、审批、查看事件、产物、技能、任务和配置；还不是 ChatGPT 式对话界面。

