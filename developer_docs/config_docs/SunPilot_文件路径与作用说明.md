# SunPilot 文件路径与作用说明

本文档总结 SunPilot 当前运行、安装、构建、部署过程中会出现的主要文件和目录，以及它们各自的作用。

## 1. 总览

SunPilot 当前会涉及四类路径：

1. 命令入口路径：让 `sun start` 可以在任何目录执行。
2. 用户运行数据路径：保存 daemon token、pid、数据库、日志、产物等。
3. 项目源码与构建路径：保存源码、构建产物和依赖。
4. 服务器部署路径：Nginx 域名反向代理配置。

当前默认用户是：

```text
ubuntu
```

所以很多路径都位于：

```text
/home/ubuntu
```

## 2. 命令入口路径

### 2.1 `~/.local/bin/sun`

完整路径：

```text
/home/ubuntu/.local/bin/sun
```

作用：

- 这是 `sun` 命令的全局入口。
- 只要 `~/.local/bin` 在 `PATH` 中，就可以在任意目录执行：

```bash
sun start
sun status
sun open
sun stop
```

来源：

```text
scripts/link-sun-bin.mjs
```

当前实现中，它是一个软链接，指向项目里的 launcher 构建产物：

```text
/home/ubuntu/code/SunPilot/packages/launcher/dist/index.js
```

检查方式：

```bash
which sun
ls -l ~/.local/bin/sun
```

是否可以删除：

- 可以删除，但删除后 `sun` 命令会失效。
- 重新执行 `pnpm install` 或 `node scripts/link-sun-bin.mjs` 可重新创建。

### 2.2 `~/.local/bin`

完整路径：

```text
/home/ubuntu/.local/bin
```

作用：

- 当前用户自己的可执行命令目录。
- `sun` 命令软链接放在这里。

检查是否在 PATH 中：

```bash
echo $PATH | tr ':' '\n' | grep "$HOME/.local/bin"
```

如果没有输出，需要把它加入 `~/.bashrc`：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 3. SunPilot 用户运行数据目录

### 3.1 `~/.sunpilot`

完整路径：

```text
/home/ubuntu/.sunpilot
```

作用：

- SunPilot 默认运行数据根目录。
- daemon 启动时自动创建。
- 可通过环境变量 `SUNPILOT_HOME` 覆盖。

相关代码：

```text
packages/storage/src/paths.ts
```

是否可以删除：

- 可以删除，但会清空本地运行数据，包括 token、数据库、日志、产物、历史 run。
- 删除后下次 daemon 启动会重新初始化。
- 生产环境不建议随意删除。

### 3.2 `~/.sunpilot/config.json`

完整路径：

```text
/home/ubuntu/.sunpilot/config.json
```

作用：

- 本地配置文件。
- daemon 启动时如果不存在会自动生成。

当前默认内容包括：

```json
{
  "version": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 3737
  },
  "security": {
    "requireLocalToken": true,
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

### 3.3 `~/.sunpilot/runtime`

完整路径：

```text
/home/ubuntu/.sunpilot/runtime
```

作用：

- 保存 daemon 运行期文件。
- 当前主要包含 token 和 pid。

### 3.4 `~/.sunpilot/runtime/auth-token`

完整路径：

```text
/home/ubuntu/.sunpilot/runtime/auth-token
```

作用：

- 本地 API 访问 token。
- Web 控制台和 REST API 请求需要它。
- `sun open` 会读取这个 token，然后生成：

```text
https://tradeagent.asia/?token=...
```

生成方式：

- daemon 或 launcher 调用 `ensureLocalToken()`。
- 如果文件不存在，自动生成 `sun_` 开头的随机 token。
- 文件权限会设置为 `0600`。

查看方式：

```bash
cat ~/.sunpilot/runtime/auth-token
```

是否可以删除：

- 可以删除。
- 删除后下次启动或 `sun open` 会生成新 token。
- 旧浏览器 localStorage 中保存的旧 token 会失效，需要重新用 `sun open` 获取新 URL。

### 3.5 `~/.sunpilot/runtime/daemon.pid`

完整路径：

```text
/home/ubuntu/.sunpilot/runtime/daemon.pid
```

作用：

- 保存当前 daemon 后台进程的 PID。
- `sun stop` 依赖它找到 daemon 进程并发送 `SIGTERM`。

查看方式：

```bash
cat ~/.sunpilot/runtime/daemon.pid
ps -p "$(cat ~/.sunpilot/runtime/daemon.pid)"
```

是否可以删除：

- 不建议在 daemon 正常运行时手动删除。
- 删除后 `sun stop` 可能找不到进程。
- 如果 pid 文件残留但进程已不存在，可以删除。

### 3.6 Docker PostgreSQL 数据卷

数据位置：

```text
Docker volume: sunpilot_pg_data
Container path: /var/lib/postgresql/data
```

作用：

- PostgreSQL 主数据库。
- 保存 runs、steps、events、approvals、artifacts、memory、jobs、skills、workflows、audit logs 等。
- 本地开发默认由项目根目录 `docker-compose.yml` 中的 `postgres` 服务提供。

相关代码：

```text
docker-compose.yml
packages/storage/src/database/database.config.ts
packages/storage/src/postgres/
```

是否可以删除：

- 删除会清空所有运行历史、审批、记忆、任务状态、技能记录等。
- 生产环境不要随意删除。
- 如需清空本地开发数据库，先停止 daemon，再执行 `docker compose down -v`。

### 3.7 `~/.sunpilot` 中不再保存主数据库文件

历史版本可能出现：

```text
/home/ubuntu/.sunpilot/sunpilot.db
/home/ubuntu/.sunpilot/sunpilot.db-wal
/home/ubuntu/.sunpilot/sunpilot.db-shm
```

作用：

- 这些是旧 SQLite 实现产生的文件。
- 当前主数据库已经迁移到 Docker PostgreSQL。

是否可以删除：

- 确认不再需要旧历史数据后可以删除。
- 当前代码不会再使用这些文件作为主数据库。

### 3.8 `~/.sunpilot/logs`

完整路径：

```text
/home/ubuntu/.sunpilot/logs
```

作用：

- 保存运行日志。
- daemon 初始化时自动创建。

### 3.9 `~/.sunpilot/logs/daemon.log`

作用：

- daemon 日志文件。
- 当前 Fastify 主要输出仍取决于启动方式和 logger 配置。

### 3.10 `~/.sunpilot/logs/audit.log`

作用：

- 审计日志文件。
- 用于记录高风险操作、审批、技能执行、文件访问、secret 读取等审计信息。

### 3.11 `~/.sunpilot/logs/skill.log`

作用：

- skill 执行日志。
- Skill runner 的 logger 会写入这里。
- 写入前会做敏感信息 redaction。

### 3.12 `~/.sunpilot/artifacts`

完整路径：

```text
/home/ubuntu/.sunpilot/artifacts
```

作用：

- 保存 run 产生的产物文件。
- 例如 fixture echo workflow 会生成 `echo-result.json`。

常见结构：

```text
~/.sunpilot/artifacts/runs/<run_id>/<artifact_file>
```

是否可以删除：

- 删除后历史 run 中的产物下载会失效。

### 3.13 `~/.sunpilot/skills`

完整路径：

```text
/home/ubuntu/.sunpilot/skills
```

作用：

- 用户本地安装的自定义 skills 目录。
- 当前项目还会加载仓库内置 fixture skills。

是否可以删除：

- 如果没有安装自定义 skills，删除影响不大。
- 删除已安装 skills 会导致对应能力不可用。

### 3.14 `~/.sunpilot/cache`

完整路径：

```text
/home/ubuntu/.sunpilot/cache
```

作用：

- 预留缓存目录。
- 当前主要是运行结构的一部分。

### 3.15 `~/.sunpilot/analytics`

完整路径：

```text
/home/ubuntu/.sunpilot/analytics
```

作用：

- DuckDB analytics adapter 的预留目录。
- 当前实现是 stub 初始化。

### 3.16 `~/.sunpilot/vectors/lance`

完整路径：

```text
/home/ubuntu/.sunpilot/vectors/lance
```

作用：

- LanceDB vector adapter 的预留目录。
- 当前实现是 stub 初始化。

## 4. 项目源码与构建路径

### 4.1 项目根目录

完整路径：

```text
/home/ubuntu/code/SunPilot
```

作用：

- 当前 Git 仓库源码目录。
- 包含 monorepo、源码、测试、文档和配置。

### 4.2 `node_modules`

可能出现：

```text
/home/ubuntu/code/SunPilot/node_modules
packages/*/node_modules
tests/integration/node_modules
```

作用：

- pnpm 安装依赖产生的目录或链接。

是否上传 GitHub：

- 不上传。
- 已被 `.gitignore` 忽略。

是否可以删除：

- 可以删除。
- 删除后需要重新执行：

```bash
pnpm install
```

### 4.3 `packages/*/dist`

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
packages/skills/fixtures/*/dist
```

作用：

- TypeScript / Vite 构建产物。
- `sun` 命令软链接当前指向 `packages/launcher/dist/index.js`。
- daemon 会从 `packages/web/dist` 服务前端页面。

是否上传 GitHub：

- 不上传。
- 已被 `.gitignore` 忽略。

是否可以删除：

- 可以删除，但删除后 `sun` 或 daemon Web 页面可能无法运行。
- 删除后重新执行：

```bash
pnpm build
```

### 4.4 `packages/launcher/dist/index.js`

完整路径：

```text
/home/ubuntu/code/SunPilot/packages/launcher/dist/index.js
```

作用：

- `sun` CLI 的实际执行文件。
- `~/.local/bin/sun` 软链接指向它。

如果它不存在：

```bash
pnpm --filter @sunpilot/launcher build
```

或：

```bash
pnpm build
```

### 4.5 `packages/web/dist`

完整路径：

```text
/home/ubuntu/code/SunPilot/packages/web/dist
```

作用：

- Vite 构建后的 Web 静态文件。
- daemon 优先从该目录托管页面。

如果页面没有更新：

```bash
pnpm --filter @sunpilot/web build
```

然后浏览器 `Ctrl+F5` 强制刷新。

## 5. Git 与文档路径

### 5.1 `.gitignore`

位置：

```text
/home/ubuntu/code/SunPilot/.gitignore
```

作用：

- 排除不上传 GitHub 的文件。

当前忽略重点：

```text
node_modules/
dist/
packages/*/dist/
packages/skills/fixtures/*/dist/
.sunpilot/
*.log
*.db
*.db-shm
*.db-wal
developer_docs/dev_docs/
```

### 5.2 `developer_docs/cmd_docs`

作用：

- 保存命令使用说明。
- 可以上传 GitHub。

### 5.3 `developer_docs/config_docs`

作用：

- 保存配置、环境变量、文件路径说明。
- 可以上传 GitHub。

### 5.4 `developer_docs/dev_docs`

作用：

- 保存开发总结类文档。

当前规则：

- 不上传 GitHub。
- 已被 `.gitignore` 忽略。

## 6. Nginx 配置路径

### 6.1 `/etc/nginx/sites-available/tradeagent`

作用：

- `tradeagent.asia` 的 Nginx 站点配置文件。
- 当前配置为反向代理到 SunPilot daemon：

```text
http://127.0.0.1:3737
```

### 6.2 `/etc/nginx/sites-enabled/tradeagent`

作用：

- Nginx 启用中的站点软链接。
- 指向：

```text
/etc/nginx/sites-available/tradeagent
```

### 6.3 旧配置备份

曾创建过旧站点备份：

```text
/etc/nginx/sites-available/tradeagent.bak.20260605004031
```

作用：

- 备份旧项目 Nginx 配置。
- 当前线上访问不依赖它。

### 6.4 检查 Nginx

测试配置：

```bash
sudo nginx -t
```

重载配置：

```bash
sudo systemctl reload nginx
```

查看状态：

```bash
sudo systemctl status nginx --no-pager
```

## 7. 常见排查命令

### 7.1 检查 `sun` 命令在哪里

```bash
which sun
ls -l "$(which sun)"
```

### 7.2 检查 daemon 是否在线

```bash
sun status
curl http://127.0.0.1:3737/healthz
```

### 7.3 检查 pid 对应进程

```bash
cat ~/.sunpilot/runtime/daemon.pid
ps -p "$(cat ~/.sunpilot/runtime/daemon.pid)" -o pid,cmd
```

### 7.4 检查 token

```bash
cat ~/.sunpilot/runtime/auth-token
```

### 7.5 生成网页登录 URL

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
echo "https://tradeagent.asia/?token=$TOKEN"
```

### 7.6 检查本地数据目录

```bash
find ~/.sunpilot -maxdepth 3 -print | sort
```

### 7.7 检查哪些文件不会上传 GitHub

```bash
git status --short --ignored
```

## 8. 哪些文件最重要

生产运行时最重要：

```text
~/.local/bin/sun
~/.sunpilot/runtime/auth-token
~/.sunpilot/runtime/daemon.pid
Docker volume: sunpilot_pg_data
~/.sunpilot/artifacts
/home/ubuntu/code/SunPilot/packages/launcher/dist/index.js
/home/ubuntu/code/SunPilot/packages/web/dist
/etc/nginx/sites-available/tradeagent
```

其中：

- `auth-token` 影响网页登录和 API 调用。
- `daemon.pid` 影响 `sun stop`。
- `sunpilot_pg_data` 保存 PostgreSQL 历史和状态。
- `artifacts` 保存运行产物。
- `launcher/dist/index.js` 是 `sun` 命令实际执行文件。
- `web/dist` 是网页前端。
- Nginx 配置影响域名访问。

## 9. 哪些文件不要上传 GitHub

不要上传：

```text
node_modules/
dist/
packages/*/dist/
packages/skills/fixtures/*/dist/
~/.sunpilot/
*.log
*.db
*.db-shm
*.db-wal
developer_docs/dev_docs/
```

原因：

- `node_modules` 是依赖包，体积大，可通过 `pnpm install` 重建。
- `dist` 是构建产物，可通过 `pnpm build` 重建。
- `~/.sunpilot` 是本地运行数据，包含 token、数据库、日志和产物。
- `*.db` / `*.log` 是本地状态和日志。
- `developer_docs/dev_docs` 按当前要求不上传。
