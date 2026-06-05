<p align="center">
  <img src="packages/web/public/logo.png" alt="SunPilot logo" width="180" />
</p>

<h1 align="center">SunPilot</h1>

<p align="center">
  <strong>Daemon-first local business agent runtime</strong>
</p>

<p align="center">
  <img alt="Product" src="https://img.shields.io/badge/PRODUCT-SUNPILOT-2563eb?style=for-the-badge" />
  <img alt="Positioning" src="https://img.shields.io/badge/POSITIONING-LOCAL_AGENT-10b981?style=for-the-badge" />
  <img alt="Runtime" src="https://img.shields.io/badge/RUNTIME-DAEMON_FIRST-f59e0b?style=for-the-badge" />
  <img alt="Interface" src="https://img.shields.io/badge/INTERFACE-CHAT_WORKSPACE-8b5cf6?style=for-the-badge" />
</p>

<p align="center">
  <img alt="Frontend" src="https://img.shields.io/badge/FRONTEND-React_19-1677ff?style=flat-square" />
  <img alt="Backend" src="https://img.shields.io/badge/BACKEND-Fastify-111827?style=flat-square" />
  <img alt="Language" src="https://img.shields.io/badge/LANGUAGE-TypeScript-3178c6?style=flat-square" />
  <img alt="Database" src="https://img.shields.io/badge/DATABASE-PostgreSQL-336791?style=flat-square" />
  <img alt="Streaming" src="https://img.shields.io/badge/STREAMING-WebSocket_JSON--RPC-ef4444?style=flat-square" />
  <img alt="LLM" src="https://img.shields.io/badge/LLM-OpenAI--compatible-0f766e?style=flat-square" />
  <img alt="Node" src="https://img.shields.io/badge/NODE-%3E%3D22.22.2%20%3C23-3c873a?style=flat-square" />
  <img alt="Package manager" src="https://img.shields.io/badge/PNPM-%3E%3D11.5.1-f69220?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/LICENSE-MIT-blue?style=flat-square" />
</p>

---

SunPilot is a local-first business agent platform centered on an always-on daemon. It combines a Chat-first web workspace, an OpenAI-compatible streaming agent, PostgreSQL persistence, workflow execution, skill runtime, approvals, artifacts, audit logs, and a compact `sun` launcher into one local product surface.

The project is designed for teams and operators who want an AI agent that feels close to the machine: easy to start, reachable through a browser, able to stream answers in real time, and ready to grow into workflow automation and skill-based business operations.

## Product Positioning

SunPilot is not just a chat UI. It is a daemon-first runtime for local business agents.

- **Daemon**: a local Fastify service on `127.0.0.1:3737` that owns API, WebSocket, static Web serving, runtime orchestration, and process state.
- **Agent**: an OpenAI-compatible streaming assistant, currently defaulting to DeepSeek, with conversation persistence and WebSocket delta delivery.
- **Workspace**: a React Chat-first product surface served by the daemon and designed as the user-facing operating console.
- **Runtime**: workflow, job, step, approval, artifact, memory, audit, skill, and capability APIs for business automation.
- **Launcher**: a minimal `sun` command for start, stop, status, and open workflows.
- **Local-first deployment**: PostgreSQL is provided by Docker Compose in development, while Nginx can expose the daemon through a trusted domain.

## Architecture

```text
Browser
  |
  | HTTPS / WebSocket JSON-RPC
  v
Nginx or localhost
  |
  | proxy_pass http://127.0.0.1:3737
  v
SunPilot daemon
  |                 |
  | PostgreSQL     | OpenAI-compatible HTTP streaming
  v                 v
Docker PostgreSQL  DeepSeek / compatible LLM
```

## What Is Implemented

- Chat-first React web app
- WebSocket JSON-RPC endpoint at `/v1/ws`
- Streaming assistant deltas from daemon to browser
- REST APIs for conversations, runs, workflows, skills, approvals, artifacts, audit logs, jobs, capabilities, memory, and config
- PostgreSQL repository layer and migrations
- Workflow runtime ready for local workflows
- Skill registry and runner with permission checks
- Local runtime directories under `~/.sunpilot`
- `sun` / `sunpilot` launcher
- Reverse-proxy friendly defaults for `https://tradeagent.asia`

Local token auth is disabled during the current test phase. Browser origins are still restricted to local origins and trusted deployment origins.

## Quick Start

```bash
pnpm install
docker compose up -d postgres
pnpm build
sun start
```

Open the product:

```bash
sun open
```

For local-only browser access:

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

## Database

Default PostgreSQL connection:

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

If port `5432` is already occupied:

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

## Agent Model

SunPilot uses an OpenAI-compatible chat completions provider and defaults to DeepSeek:

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=your_api_key
```

`DEEPSEEK_API_KEY` is also accepted as a fallback secret name.

Do not commit API keys. Put secrets in your shell profile, process manager, systemd unit, or deployment environment.

## Commands

```bash
sun start
sun start --foreground
sun status
sun open
sun stop
```

Development scripts:

```bash
pnpm build
pnpm test
pnpm lint
pnpm dev:daemon
pnpm dev:web
```

## API Smoke Tests

```bash
curl http://127.0.0.1:3737/healthz
curl http://127.0.0.1:3737/readyz
curl http://127.0.0.1:3737/v1/conversations
curl -X POST http://127.0.0.1:3737/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Introduce SunPilot in one sentence."}'
```

WebSocket ping:

```bash
node --input-type=module -e 'const ws=new WebSocket("ws://127.0.0.1:3737/v1/ws"); ws.addEventListener("open",()=>ws.send(JSON.stringify({jsonrpc:"2.0",id:"ping_1",method:"ping",params:{}}))); ws.addEventListener("message",(event)=>{ console.log(String(event.data)); ws.close(); });'
```

## Reverse Proxy

The daemon trusts `https://tradeagent.asia` and `https://www.tradeagent.asia` by default. Add more origins with `SUNPILOT_ALLOWED_ORIGINS`.

```nginx
server {
  server_name tradeagent.asia;

  location / {
    proxy_pass http://127.0.0.1:3737;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
  }
}
```

## Developer Docs

Chinese developer docs live in `developer_docs/`:

- `developer_docs/cmd_docs/`
- `developer_docs/config_docs/`
- `developer_docs/dev_docs/`

`developer_docs/dev_docs/` is ignored by Git and intended for local implementation notes.

## License

SunPilot is released under the [MIT License](LICENSE).
