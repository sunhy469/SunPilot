# SunPilot 文件路径与作用说明

本文档使用中文说明 SunPilot 当前运行、安装、构建、部署过程中会出现的主要文件和目录。

更新时间：2026-06-05

## 1. 路径总览

SunPilot 当前主要涉及四类路径：

1. 命令入口路径：让 `sun start` 可以在任意目录执行。
2. 用户运行数据路径：保存配置、pid、日志、产物、自定义 skills 等。
3. 项目源码与构建路径：保存 monorepo 源码、测试、构建产物和依赖。
4. 部署路径：Nginx 反向代理和域名访问配置。

当前示例用户是：

```text
ubuntu
```

所以示例完整路径会以 `/home/ubuntu` 开头。其他用户环境应替换为自己的 `$HOME`。

## 2. 命令入口路径

### 2.1 `~/.local/bin/sun`

示例完整路径：

```text
/home/ubuntu/.local/bin/sun
```

作用：

- `sun` 命令的全局入口。
- 只要 `~/.local/bin` 在 `PATH` 中，就可以在任意目录执行 `sun start`、`sun status`、`sun open`、`sun stop`。
- 由根目录 `postinstall` 脚本创建。

来源脚本：

```text
scripts/link-sun-bin.mjs
```

当前实现中，它是一个软链接，指向：

```text
/home/ubuntu/code/SunPilot/packages/launcher/dist/index.js
```

检查方式：

```bash
which sun
ls -l ~/.local/bin/sun
```

重新创建：

```bash
pnpm install
```

或：

```bash
node scripts/link-sun-bin.mjs
```

### 2.2 `~/.local/bin`

作用：

- 当前用户自己的可执行命令目录。
- `sun` 软链接放在这里。

检查是否在 `PATH` 中：

```bash
echo $PATH | tr ':' '\n' | grep "$HOME/.local/bin"
```

如无输出，可加入 `~/.bashrc`：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 3. 用户运行数据目录

### 3.1 `~/.sunpilot`

示例完整路径：

```text
/home/ubuntu/.sunpilot
```

作用：

- SunPilot 默认运行数据根目录。
- daemon 启动时自动创建。
- 可通过 `SUNPILOT_HOME` 覆盖。

相关代码：

```text
packages/storage/src/paths.ts
```

默认结构：

```text
~/.sunpilot/
├── config.json
├── analytics/
├── artifacts/
├── cache/
├── logs/
│   ├── audit.log
│   ├── daemon.log
│   └── skill.log
├── runtime/
│   └── daemon.pid
├── skills/
└── vectors/
    └── lance/
```

是否可以删除：

- 本地开发环境可以删除，但会清空本地配置、日志、产物和自定义 skills。
- 生产环境不建议随意删除。
- 删除后下次 daemon 启动会重新初始化基础目录和配置。

### 3.2 `~/.sunpilot/config.json`

作用：

- 本地配置文件。
- 不存在时由 `ensureSunPilotHome` 自动生成。

默认内容类似：

```json
{
  "version": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 3737
  },
  "security": {
    "requireLocalToken": false,
    "allowLan": false
  },
  "skills": {
    "directories": ["/home/ubuntu/.sunpilot/skills"],
    "autoReload": true
  },
  "workflows": {
    "directories": ["/home/ubuntu/.sunpilot/workflows"],
    "autoReload": true
  },
  "storage": {
    "home": "/home/ubuntu/.sunpilot"
  }
}
```

注意：

- 当前代码会强制 `server.host` 为 `127.0.0.1`。
- 当前代码会强制 `security.allowLan` 为 `false`。
- 当前测试阶段 `security.requireLocalToken` 默认为 `false`。

### 3.3 `~/.sunpilot/runtime/daemon.pid`

作用：

- 保存当前 daemon 后台进程 PID。
- `sun stop` 依赖它查找进程并发送 `SIGTERM`。

查看方式：

```bash
cat ~/.sunpilot/runtime/daemon.pid
ps -p "$(cat ~/.sunpilot/runtime/daemon.pid)"
```

是否可以删除：

- daemon 正常运行时不建议手动删除。
- 如果 pid 文件残留但进程已不存在，可以删除。

### 3.4 历史遗留 `~/.sunpilot/runtime/auth-token`

历史版本可能存在：

```text
~/.sunpilot/runtime/auth-token
```

当前状态：

- 本地 token 验证在测试阶段关闭。
- 当前代码不再依赖该文件访问 Web 或 API。
- 如果确认是旧文件，可以删除。

### 3.5 `~/.sunpilot/logs`

作用：

- 保存运行日志。
- daemon 初始化时确保存在。

当前日志文件：

| 文件         | 作用                                         |
| ------------ | -------------------------------------------- |
| `daemon.log` | daemon 启动记录和部分运行日志                |
| `audit.log`  | 审计日志文件                                 |
| `skill.log`  | skill 执行日志，写入前会做敏感信息 redaction |

### 3.6 `~/.sunpilot/artifacts`

作用：

- 保存 workflow run 或 skill 产生的产物文件。

常见结构：

```text
~/.sunpilot/artifacts/runs/<run_id>/<artifact_file>
```

删除影响：

- 删除后历史 run 中的 artifact content 下载会失效。

### 3.7 `~/.sunpilot/skills`

作用：

- 用户本地安装的自定义 skills 目录。
- 当前仓库不再内置 fixture skills，daemon 默认只加载该目录中的用户 skill。

删除影响：

- 未安装自定义 skills 时影响较小。
- 已安装 skills 会变为不可用。

### 3.8 `~/.sunpilot/cache`

作用：

- 预留缓存目录。
- 当前主要是运行目录结构的一部分。

### 3.9 `~/.sunpilot/analytics`

作用：

- DuckDB analytics adapter 的预留目录。
- 当前实现是 stub 初始化。

### 3.10 `~/.sunpilot/vectors/lance`

作用：

- LanceDB vector adapter 的预留目录。
- 当前实现是 stub 初始化。

## 4. PostgreSQL 数据路径

当前主数据库由 Docker Compose PostgreSQL 提供，不再使用 `~/.sunpilot/sunpilot.db` 作为主数据库。

Docker 数据位置：

```text
Docker volume: sunpilot_pg_data
Container path: /var/lib/postgresql/data
```

作用：

- 保存 conversations、messages、runs、steps、events、approvals、artifacts、memory、jobs、skills、workflows、audit logs 等。
- 本地开发默认由项目根目录 `docker-compose.yml` 中的 `postgres` 服务提供。

相关代码：

```text
docker-compose.yml
packages/storage/src/database/database.config.ts
packages/storage/src/postgres/
packages/storage/src/migrations/
```

清空本地开发数据库：

```bash
sun stop
docker compose down -v
docker compose up -d postgres
```

生产环境不要随意删除 PostgreSQL 数据卷。

### 4.1 旧 SQLite 文件

历史版本可能出现：

```text
~/.sunpilot/sunpilot.db
~/.sunpilot/sunpilot.db-wal
~/.sunpilot/sunpilot.db-shm
```

当前状态：

- 这些是旧 SQLite 实现产生的文件。
- 当前主数据库已经迁移到 PostgreSQL。
- 确认不需要旧历史数据后可以删除。

## 5. 项目源码与构建路径

### 5.1 项目根目录

示例完整路径：

```text
/home/ubuntu/code/SunPilot
```

作用：

- 当前 Git 仓库源码目录。
- 包含 monorepo、源码、测试、文档和配置。

### 5.2 `node_modules`

可能出现：

```text
node_modules
packages/*/node_modules
tests/integration/node_modules
```

作用：

- pnpm 安装依赖产生的目录或链接。

是否上传 Git：

- 不上传。
- 已被 `.gitignore` 忽略。

重新安装：

```bash
pnpm install
```

### 5.3 `packages/*/dist`

可能出现：

```text
packages/web/dist
packages/core/dist
packages/daemon/dist
packages/launcher/dist
packages/protocol/dist
packages/storage/dist
packages/workflow/dist
packages/skill-runner/dist
packages/skill-sdk/dist
```

作用：

- TypeScript / Vite 构建产物。
- `sun` 软链接指向 `packages/launcher/dist/index.js`。
- daemon 从 `packages/web/dist` 托管前端页面。

是否上传 Git：

- 不上传。
- 已被 `.gitignore` 忽略。

重新构建：

```bash
pnpm build
```

### 5.4 `packages/web/dist`

作用：

- Vite 构建后的 Web 静态文件。
- daemon 优先从该目录托管 Chat-first Web 页面。

如果页面没有更新：

```bash
pnpm --filter @sunpilot/web build
sun stop
sun start
```

然后浏览器强制刷新。

## 6. 重要源码路径

| 路径                               | 作用                                     |
| ---------------------------------- | ---------------------------------------- |
| `packages/launcher/src/index.ts`   | `sun` / `sunpilot` CLI                   |
| `packages/daemon/src/server.ts`    | Fastify REST、WebSocket、静态 Web 托管   |
| `packages/core/src/agent/`         | conversation / chat agent service        |
| `packages/core/src/llm/`           | OpenAI-compatible streaming LLM provider |
| `packages/core/src/runtime/`       | workflow runtime 编排                    |
| `packages/storage/src/postgres/`   | PostgreSQL repositories                  |
| `packages/storage/src/migrations/` | 数据库迁移 SQL                           |
| `packages/web/src/pages/ChatPage/` | 当前主要 Web 页面                        |
| `packages/web/src/features/chat/`  | WebSocket chat client                    |
| `tests/integration/`               | daemon 集成测试                          |

## 7. 文档路径

### 7.1 `README.md`

作用：

- 仓库英文入口文档。
- 面向快速启动、架构和常用命令。

### 7.2 `developer_docs/cmd_docs`

作用：

- 中文命令使用说明。
- 可以进入 Git。

### 7.3 `developer_docs/config_docs`

作用：

- 中文配置、路径、环境变量说明。
- 可以进入 Git。

### 7.4 `developer_docs/dev_docs`

作用：

- 中文本地开发总结和阶段性实现说明。
- 当前 `.gitignore` 忽略该目录，默认不进入 Git 提交。

## 8. `.gitignore`

位置：

```text
.gitignore
```

当前忽略重点：

```text
node_modules/
dist/
packages/*/dist/
.sunpilot/
*.log
*.db
*.db-shm
*.db-wal
developer_docs/dev_docs/
```

含义：

- 构建产物、本地数据库、日志、运行数据不进入仓库。
- `developer_docs/dev_docs/` 是本地开发记录，不默认提交。

## 9. 部署相关路径

Nginx 配置通常位于系统目录，例如：

```text
/etc/nginx/sites-available/
/etc/nginx/sites-enabled/
```

当前反向代理目标：

```text
http://127.0.0.1:3737
```

WebSocket 必须保留：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;
```
