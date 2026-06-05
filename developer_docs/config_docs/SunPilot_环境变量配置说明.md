# SunPilot 环境变量配置说明

本文档使用中文汇总当前 SunPilot 工程涉及的环境变量、默认值、使用位置和配置注意事项。

更新时间：2026-06-05

## 1. 配置方式

当前项目不会自动加载 `.env` 文件。daemon 由 `sun start` 启动时，会继承当前 shell 中已经存在的环境变量。

典型流程：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
sun stop
sun start
```

如果只执行 `export`，但不重启后台 daemon，旧 daemon 不会自动拿到新变量。

## 2. 长期生效

建议把长期配置写入当前用户的 shell 配置，例如：

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

生效：

```bash
source ~/.bashrc
sun stop
sun start
```

不要把 API key、数据库生产密码或其他 secret 写入仓库文件。

## 3. 环境变量总览

| 变量名                           | 默认值                                                                | 是否必填 | 使用模块              | 作用                                         |
| -------------------------------- | --------------------------------------------------------------------- | -------- | --------------------- | -------------------------------------------- |
| `SUNPILOT_HOME`                  | `~/.sunpilot`                                                         | 否       | storage               | 指定本地运行数据目录                         |
| `SUNPILOT_PORT`                  | `3737`                                                                | 否       | launcher / daemon     | 指定 daemon 端口                             |
| `SUNPILOT_WEB_URL`               | `https://tradeagent.asia`                                             | 否       | launcher              | 指定 `sun open` 打开的 Web 地址              |
| `SUNPILOT_CONSOLE_URL`           | `https://tradeagent.asia`                                             | 否       | launcher              | 旧变量名，仅作为 `SUNPILOT_WEB_URL` fallback |
| `SUNPILOT_ALLOWED_ORIGINS`       | 空                                                                    | 否       | daemon                | 追加允许访问 daemon 的浏览器 Origin          |
| `SUNPILOT_LOG_LEVEL`             | `info`                                                                | 否       | daemon                | Fastify 日志级别                             |
| `SUNPILOT_SKILL_TIMEOUT_MS`      | `300000`                                                              | 否       | daemon / skill-runner | 单个 skill 最大执行时间                      |
| `SUNPILOT_SKILL_MAX_CONCURRENCY` | `4`                                                                   | 否       | daemon / skill-runner | skill 最大并发数                             |
| `SUNPILOT_DATABASE_PROVIDER`     | `postgres`                                                            | 否       | storage               | 主数据库类型；当前只支持 PostgreSQL          |
| `SUNPILOT_DATABASE_URL`          | `postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot` | 否       | storage               | PostgreSQL 连接字符串                        |
| `SUNPILOT_LLM_BASE_URL`          | `https://api.deepseek.com`                                            | 否       | core LLM              | OpenAI-compatible API base URL               |
| `SUNPILOT_LLM_MODEL`             | `deepseek-v4-flash`                                                   | 否       | core LLM              | 默认模型名称                                 |
| `SUNPILOT_LLM_API_KEY`           | 无                                                                    | 是       | core LLM              | OpenAI-compatible API key                    |
| `DEEPSEEK_API_KEY`               | 无                                                                    | 备用     | core LLM              | DeepSeek API key 备用变量名                  |

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

- 指定 SunPilot 本地状态目录。
- 影响 `config.json`、artifacts、skills、logs、cache、runtime、stub analytics/vector 目录。
- 不再保存主数据库文件；当前主数据库由 PostgreSQL 提供。

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
packages/daemon/src/main.ts
```

作用：

- 指定 `sun start` 启动 daemon 的端口。
- 指定 `sun status` 检查的端口。
- launcher 启动 daemon 时会把该端口写入子进程环境。

示例：

```bash
export SUNPILOT_PORT=3738
sun start
```

也可以临时指定：

```bash
sun start --port 3738
sun status --port 3738
```

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

- 控制 `sun open` 打开和输出的地址。
- 不影响 daemon 实际监听地址。

示例：

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

### 4.4 `SUNPILOT_CONSOLE_URL`

旧变量名。只有在 `SUNPILOT_WEB_URL` 未设置时，launcher 才会读取它。

优先级：

```text
SUNPILOT_WEB_URL > SUNPILOT_CONSOLE_URL > https://tradeagent.asia
```

### 4.5 `SUNPILOT_ALLOWED_ORIGINS`

默认值：

```bash
空
```

使用位置：

```text
packages/daemon/src/server.ts
```

作用：

- 追加允许访问 daemon API 和 WebSocket 的浏览器 Origin。
- 多个 Origin 用英文逗号分隔。

daemon 内置允许：

```text
https://tradeagent.asia
https://www.tradeagent.asia
http://127.0.0.1:<daemon_port>
http://localhost:<daemon_port>
http://127.0.0.1:3737
http://localhost:3737
http://127.0.0.1:3738
http://localhost:3738
```

示例：

```bash
export SUNPILOT_ALLOWED_ORIGINS=https://example.com,https://www.example.com
sun stop
sun start
```

### 4.6 `SUNPILOT_LOG_LEVEL`

默认值：

```bash
info
```

使用位置：

```text
packages/daemon/src/server.ts
```

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

### 4.7 `SUNPILOT_SKILL_TIMEOUT_MS`

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

### 4.8 `SUNPILOT_SKILL_MAX_CONCURRENCY`

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

### 4.9 `SUNPILOT_DATABASE_PROVIDER`

默认值：

```bash
postgres
```

使用位置：

```text
packages/storage/src/database/database.config.ts
```

作用：

- 指定主数据库类型。
- 当前阶段只支持 `postgres`。
- 设置为 `sqlite` 会抛出配置错误。

示例：

```bash
export SUNPILOT_DATABASE_PROVIDER=postgres
```

### 4.10 `SUNPILOT_DATABASE_URL`

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
- 本地开发默认配合项目根目录 `docker-compose.yml` 的 `postgres` 服务使用。

示例：

```bash
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
sun stop
sun start
```

### 4.11 `SUNPILOT_LLM_BASE_URL`

默认值：

```bash
https://api.deepseek.com
```

使用位置：

```text
packages/core/src/llm/llm.config.ts
packages/core/src/llm/openai-compatible.provider.ts
```

作用：

- 指定 OpenAI-compatible chat completions 服务地址。
- provider 会请求 `${baseUrl}/chat/completions`。

示例：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
```

### 4.12 `SUNPILOT_LLM_MODEL`

默认值：

```bash
deepseek-v4-flash
```

使用位置：

```text
packages/core/src/llm/llm.config.ts
packages/core/src/llm/openai-compatible.provider.ts
```

作用：

- 指定默认 chat completions 模型名。

示例：

```bash
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
```

### 4.13 `SUNPILOT_LLM_API_KEY`

默认值：

```bash
无
```

使用位置：

```text
packages/core/src/llm/openai-compatible.provider.ts
```

作用：

- OpenAI-compatible 模型服务 API key。
- 当前推荐使用该变量名。
- 缺失时会尝试读取 `DEEPSEEK_API_KEY`。

示例：

```bash
export SUNPILOT_LLM_API_KEY=你的密钥
```

安全检查：

```bash
echo ${#SUNPILOT_LLM_API_KEY}
```

### 4.14 `DEEPSEEK_API_KEY`

默认值：

```bash
无
```

使用位置：

```text
packages/core/src/llm/openai-compatible.provider.ts
```

作用：

- `SUNPILOT_LLM_API_KEY` 的备用变量名。
- 如果两个变量都未设置，首次聊天请求会失败。

优先级：

```text
SUNPILOT_LLM_API_KEY > DEEPSEEK_API_KEY
```

## 5. Skill 内部可读取的环境变量

Skill runner 支持 skill 通过 `secrets.get(name)` 读取环境变量，但必须满足：

- skill manifest 中声明了 `permissions.env.allow`。
- 变量名在 allow list 中。

某些用户安装的 skill 可能声明并读取类似：

```bash
OPENAI_API_KEY
```

这不是 SunPilot 全局必需配置，只是 skill 权限模型中的外部 secret 名称。

安全规则：

- 未声明的 env 变量不可读。
- 读取 secret 会写入 audit log。
- 日志和存储会做敏感信息 redaction。

## 6. 推荐服务器配置

当前服务器使用域名 `tradeagent.asia` 时，推荐至少保留：

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=你的密钥
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

如果部署在其他域名，再追加：

```bash
export SUNPILOT_ALLOWED_ORIGINS=https://your-domain.example
```
