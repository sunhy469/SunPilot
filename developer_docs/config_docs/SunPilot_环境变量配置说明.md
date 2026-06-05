# SunPilot 环境变量配置说明

本文档汇总当前 SunPilot 工程涉及的环境变量、默认值、使用位置、配置方式和注意事项。

## 1. 当前配置方式

当前项目没有自动加载 `.env` 文件。

环境变量来自服务器内部的 shell / 进程环境，例如：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
export SUNPILOT_DATABASE_PROVIDER=postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

daemon 由 `sun start` 启动时，会继承当前 shell 中已经存在的环境变量。

因此配置流程是：

```bash
export 变量名=变量值
sun stop
sun start
```

如果只执行 `export`，但不重启 daemon，已经在后台运行的 daemon 不会自动拿到新变量。

## 2. 长期生效方式

如果只是临时 `export`，关闭终端后变量可能消失。

建议写入当前服务器用户的 shell 配置：

```bash
nano ~/.bashrc
```

追加：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
export SUNPILOT_DATABASE_PROVIDER=postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

保存后执行：

```bash
source ~/.bashrc
sun stop
sun start
```

不要把密钥写入仓库文件。

## 3. 环境变量总览

| 变量名 | 默认值 | 是否必填 | 使用模块 | 作用 |
| --- | --- | --- | --- | --- |
| `SUNPILOT_HOME` | `~/.sunpilot` | 否 | storage | 指定 SunPilot 本地数据目录 |
| `SUNPILOT_PORT` | `3737` | 否 | launcher / daemon | 指定 daemon 端口 |
| `SUNPILOT_WEB_URL` | `https://tradeagent.asia` | 否 | launcher | 指定 `sun open` 输出的 Web 域名 |
| `SUNPILOT_CONSOLE_URL` | `https://tradeagent.asia` | 否 | launcher | 旧变量名；仅作为 `SUNPILOT_WEB_URL` 未设置时的兼容 fallback |
| `SUNPILOT_ALLOWED_ORIGINS` | 空 | 否 | daemon | 追加允许访问 daemon 的外部 Origin |
| `SUNPILOT_LOG_LEVEL` | `info` | 否 | daemon | Fastify 日志级别 |
| `SUNPILOT_SKILL_TIMEOUT_MS` | `300000` | 否 | daemon / skill-runner | 单个 skill 最大执行时间 |
| `SUNPILOT_SKILL_MAX_CONCURRENCY` | `4` | 否 | daemon / skill-runner | skill 最大并发执行数 |
| `SUNPILOT_DATABASE_PROVIDER` | `postgres` | 否 | storage | 指定主数据库类型；当前阶段只支持 PostgreSQL |
| `SUNPILOT_DATABASE_URL` | `postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot` | 否 | storage | PostgreSQL 连接字符串 |
| `SUNPILOT_LLM_BASE_URL` | `https://api.deepseek.com` | 否 | core LLM | OpenAI-compatible 模型服务地址 |
| `SUNPILOT_LLM_MODEL` | `deepseek-v4-flash` | 否 | core LLM | 默认模型名 |
| `SUNPILOT_LLM_API_KEY` | 无 | 是 | core LLM | 模型服务 API key |
| `DEEPSEEK_API_KEY` | 无 | 备用 | core LLM | DeepSeek API key 备用变量名 |

## 4. 变量详细说明

### 4.1 `SUNPILOT_HOME`

默认值：

```bash
~/.sunpilot
```

使用位置：

```text
packages/storage/src/paths.ts
```

作用：

- 指定 SunPilot 的本地状态目录。
- 影响数据库、日志、产物、pid 文件位置。

默认目录结构：

```text
~/.sunpilot/
├── config.json
├── artifacts/
├── skills/
├── logs/
├── cache/
└── runtime/
    └── daemon.pid
```

示例：

```bash
export SUNPILOT_HOME=/data/sunpilot
sun stop
sun start
```

### 4.2 `SUNPILOT_PORT`

默认值：

```bash
3737
```

使用位置：

```text
packages/launcher/src/index.ts
```

作用：

- 指定 `sun start` 启动 daemon 的端口。
- 指定 `sun status` 检查的端口。
- 指定 `sun open` 本地端口上下文。

示例：

```bash
export SUNPILOT_PORT=3738
sun start
```

也可以通过参数临时指定：

```bash
sun start --port 3738
sun status --port 3738
```

主数据库不再保存在 `~/.sunpilot` 下。当前主数据库由 Docker PostgreSQL 提供，默认 Docker volume 为 `sunpilot_pg_data`。

### 4.3 `SUNPILOT_WEB_URL`

默认值：

```bash
https://tradeagent.asia
```

使用位置：

```text
packages/launcher/src/index.ts
```

作用：

- 控制 `sun open` 输出和尝试打开的 Web 地址。
- 当前服务器部署默认使用域名 `tradeagent.asia`。

示例：

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

输出会变成：

```text
http://127.0.0.1:3737/
```

兼容说明：

- `SUNPILOT_CONSOLE_URL` 是旧变量名。
- 如果同时设置 `SUNPILOT_WEB_URL` 和 `SUNPILOT_CONSOLE_URL`，launcher 优先使用 `SUNPILOT_WEB_URL`。

### 4.4 `SUNPILOT_ALLOWED_ORIGINS`

默认值：

```bash
空
```

使用位置：

```text
packages/daemon/src/server.ts
```

作用：

- 追加允许访问 daemon API 的外部 Origin。
- 多个 Origin 用英文逗号分隔。

daemon 当前内置允许：

```text
https://tradeagent.asia
https://www.tradeagent.asia
```

如需额外允许其他域名：

```bash
export SUNPILOT_ALLOWED_ORIGINS=https://example.com,https://www.example.com
sun stop
sun start
```

### 4.5 `SUNPILOT_LOG_LEVEL`

默认值：

```bash
info
```

使用位置：

```text
packages/daemon/src/server.ts
```

作用：

- 控制 Fastify daemon 日志级别。

常用值：

```text
silent
error
warn
info
debug
trace
```

示例：

```bash
export SUNPILOT_LOG_LEVEL=debug
sun stop
sun start --foreground
```

### 4.6 `SUNPILOT_SKILL_TIMEOUT_MS`

默认值：

```bash
300000
```

即 5 分钟。

使用位置：

```text
packages/daemon/src/server.ts
packages/skill-runner/src/runner.ts
```

作用：

- 控制单个 skill capability 的最大执行时间。
- 超时后 runner 会 abort 对应执行，并写入 audit log。

示例：

```bash
export SUNPILOT_SKILL_TIMEOUT_MS=600000
sun stop
sun start
```

### 4.7 `SUNPILOT_SKILL_MAX_CONCURRENCY`

默认值：

```bash
4
```

使用位置：

```text
packages/daemon/src/server.ts
packages/skill-runner/src/runner.ts
```

作用：

- 控制 skill runner 最大并发执行数。
- 超过并发上限的执行会等待空闲 slot。

示例：

```bash
export SUNPILOT_SKILL_MAX_CONCURRENCY=2
sun stop
sun start
```

### 4.8 `SUNPILOT_DATABASE_PROVIDER`

默认值：

```bash
postgres
```

使用位置：

```text
packages/storage/src/database/database.config.ts
```

作用：

- 指定 SunPilot 主数据库类型。
- 当前阶段只支持 `postgres`。
- `sqlite` 不再作为默认主数据库，也不再作为 fallback。

示例：

```bash
export SUNPILOT_DATABASE_PROVIDER=postgres
sun stop
sun start
```

### 4.9 `SUNPILOT_DATABASE_URL`

默认值：

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

使用位置：

```text
packages/storage/src/database/database.config.ts
```

作用：

- 指定 PostgreSQL 连接字符串。
- 本地开发默认配合项目根目录 `docker-compose.yml` 使用。

示例：

```bash
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
sun stop
sun start
```

### 4.10 `SUNPILOT_LLM_BASE_URL`

默认值：

```bash
https://api.deepseek.com
```

使用位置：

```text
packages/core/src/llm.ts
```

作用：

- 指定 OpenAI-compatible chat completions 服务地址。
- 当前默认接入 DeepSeek。

示例：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
```

### 4.11 `SUNPILOT_LLM_MODEL`

默认值：

```bash
deepseek-v4-flash
```

使用位置：

```text
packages/core/src/llm.ts
```

作用：

- 指定默认 LLM 模型名称。

示例：

```bash
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
```

### 4.12 `SUNPILOT_LLM_API_KEY`

默认值：

```bash
无
```

使用位置：

```text
packages/core/src/llm.ts
```

作用：

- OpenAI-compatible 模型服务 API key。
- 当前推荐使用该变量名。
- 必须由用户自己在服务器环境中设置。

示例：

```bash
export SUNPILOT_LLM_API_KEY=你的密钥
```

查看是否设置，不显示密钥明文：

```bash
echo ${#SUNPILOT_LLM_API_KEY}
```

### 4.13 `DEEPSEEK_API_KEY`

默认值：

```bash
无
```

使用位置：

```text
packages/core/src/llm.ts
```

作用：

- `SUNPILOT_LLM_API_KEY` 的备用变量名。
- 如果 `SUNPILOT_LLM_API_KEY` 未设置，core LLM provider 会尝试读取 `DEEPSEEK_API_KEY`。

推荐优先级：

```text
SUNPILOT_LLM_API_KEY > DEEPSEEK_API_KEY
```

示例：

```bash
export DEEPSEEK_API_KEY=你的密钥
```

## 5. Skill 内部可读取的环境变量

Skill runner 支持 skill 通过 `secrets.get(name)` 读取环境变量，但必须满足：

- skill manifest 中声明了 `permissions.env.allow`。
- 变量名在 allow list 中。

例如测试 fixture 中出现过：

```bash
OPENAI_API_KEY
```

这不是 SunPilot 全局必需配置，只是 skill 权限模型的示例 secret 名称。

安全规则：

- 未声明的 env 变量不可读。
- 读取 secret 会写入 audit log。
- 日志和存储会尽量做敏感信息 redaction。

## 6. 当前服务器推荐配置

当前服务器使用域名 `tradeagent.asia`，推荐保留：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
```

可选：

```bash
export SUNPILOT_WEB_URL=https://tradeagent.asia
export SUNPILOT_PORT=3737
export SUNPILOT_LOG_LEVEL=info
```

通常无需设置：

```bash
SUNPILOT_HOME
SUNPILOT_ALLOWED_ORIGINS
SUNPILOT_SKILL_TIMEOUT_MS
SUNPILOT_SKILL_MAX_CONCURRENCY
```

## 7. 检查当前环境变量

查看非密钥变量：

```bash
echo $SUNPILOT_LLM_BASE_URL
echo $SUNPILOT_LLM_MODEL
echo $SUNPILOT_PORT
echo $SUNPILOT_WEB_URL
```

查看密钥是否存在，只显示长度：

```bash
echo ${#SUNPILOT_LLM_API_KEY}
echo ${#DEEPSEEK_API_KEY}
```

查看所有相关变量：

```bash
printenv | grep -E 'SUNPILOT_|DEEPSEEK_API_KEY'
```

注意：该命令会打印密钥明文，如需截图或共享日志不要使用。

## 8. 重启 daemon 让配置生效

修改环境变量后执行：

```bash
sun stop
sun start
sun status
```

验证 daemon 在线：

```bash
curl http://127.0.0.1:3737/healthz
```

验证域名页面：

```bash
sun open
```

服务器无图形界面时，复制输出的 `https://tradeagent.asia/` 到本地浏览器打开。

## 9. `.env` 文件说明

当前项目没有实现 `.env` 自动加载。

因此以下方式当前不会被项目自动读取：

```text
.env
.env.local
packages/daemon/.env
packages/core/.env
```

如果未来要支持 `.env`，建议在 daemon 启动入口统一加载，并明确加载优先级，例如：

```text
系统环境变量 > .env.local > .env
```

当前阶段不要依赖 `.env`。
