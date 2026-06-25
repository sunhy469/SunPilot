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
  <img alt="Database" src="https://img.shields.io/badge/DATABASE-PostgreSQL+pgvector-336791?style=flat-square" />
  <img alt="Streaming" src="https://img.shields.io/badge/STREAMING-WebSocket_JSON--RPC-ef4444?style=flat-square" />
  <img alt="LLM" src="https://img.shields.io/badge/LLM-OpenAI--compatible-0f766e?style=flat-square" />
  <img alt="Node" src="https://img.shields.io/badge/NODE-%3E%3D22.22.2%20%3C23-3c873a?style=flat-square" />
  <img alt="Package manager" src="https://img.shields.io/badge/PNPM-%3E%3D11.5.1-f69220?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/LICENSE-AGPL_v3-blue?style=flat-square" />
</p>

---

SunPilot is a local-first AI agent runtime that runs as an always-on daemon. It combines a chat workspace web UI, a multi-model agent engine, PostgreSQL-backed persistence, an extensible skill execution system, and a compact CLI launcher into a single local product.

## Architecture

```
Browser
  │
  │ HTTP / WebSocket JSON-RPC
  v
Nginx (optional) ──► SunPilot Daemon (Fastify, port 3737)
                      │
                      ├── Agent Loop Engine
                      │   ├── Context Builder (message history + memory RAG)
                      │   ├── Intent Router (rule + embedding + LLM cascade)
                      │   ├── Tool Decision Engine (skill discovery + execution)
                      │   ├── Planner / Replanner / Plan Validator
                      │   ├── Execution Orchestrator
                      │   ├── Reflection Engine
                      │   ├── Response Composer (streaming)
                      │   ├── Memory Writer (auto-extraction + embedding)
                      │   └── Safety Layer (permission policy, approval gate,
                      │       injection detection, tool sandbox)
                      │
                      ├── PostgreSQL + pgvector (conversations, messages,
                      │   memory, runs, steps, artifacts, traces, etc.)
                      │
                      └── OpenAI-compatible LLM (DeepSeek / Volcengine Ark)
```

## Monorepo Structure

| Package | Description |
|---------|-------------|
| `packages/core` | Agent kernel — loop engine, context builder, intent router, tool decision, planning, memory, reflection, safety, model router, embedding, traces |
| `packages/daemon` | Fastify server — composition root, WebSocket, REST API, metrics, stale detection, memory pruning |
| `packages/api` | HTTP routes and WebSocket handlers — conversations, chat, runs, approvals, artifacts, config, OSS upload |
| `packages/web` | React 19 SPA — chat workspace, settings, digital world canvas |
| `packages/storage` | PostgreSQL repositories, migrations, data paths, database context |
| `packages/protocol` | Shared types — agent events/commands/errors, message parts, rich cards |
| `packages/launcher` | `sun` CLI — start/stop/restart/status/doctor/logs/open |
| `packages/platform` | Digital World — path planner, task executor, service layer |
| `packages/skill-runner` | Skill registry and execution runtime |
| `packages/skill-sdk` | SDK for building custom skills |

## Key Features

- **Agent Loop Engine** — full planning → execution → reflection → response cycle with state machine
- **Multi-Model Router** — dual LLM support (DeepSeek + Volcengine Ark), per-purpose model routing
- **Memory RAG** — semantic memory with embedding search, multi-hop retrieval, MMR reranking, query expansion, stale detection
- **Streaming Responses** — WebSocket JSON-RPC delivers assistant deltas in real time
- **Skill System** — extensible skill registry with permission-based sandboxing, tool sandbox (strict/moderate/permissive)
- **Safety Layer** — permission policy, approval gates, prompt injection detection (6 categories), task-scoped permissions
- **Trace & Observability** — per-run traces with span timing, token counts, and error tracking
- **Digital World** — 2D PixiJS workspace with a tracked digital worker for task visualization
- **PostgreSQL + pgvector** — full persistence with vector embeddings for semantic search
- **Local-first** — all data stored under `~/.sunpilot`, daemon binds to `127.0.0.1`

## Prerequisites

- **Node.js** ≥ 22.22.2 < 23
- **pnpm** ≥ 11.5.1 < 12
- **Docker** (for PostgreSQL) or an external PostgreSQL 16 instance with the `pgvector` extension
- An OpenAI-compatible API key (DeepSeek, Volcengine Ark, or any compatible provider)

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Start PostgreSQL
docker compose up -d postgres

# 3. Build all packages
pnpm build

# 4. Set your LLM API key
export SUNPILOT_DP_LLM_API_KEY=your_deepseek_api_key
# Optional: second model
export SUNPILOT_SEED_LLM_API_KEY=your_volcengine_api_key

# 5. Start the daemon
sun start

# 6. Open the web UI
sun open
```

For local-only browser access without the default production URL:

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_HOME` | `~/.sunpilot` | Data directory for logs, config, runtime |
| `SUNPILOT_PORT` | `3737` | Daemon listen port |
| `SUNPILOT_WEB_URL` | `https://tradeagent.asia` | Web UI URL (used by `sun open` and CORS) |
| `SUNPILOT_ALLOWED_ORIGINS` | (empty) | Additional allowed CORS origins |
| `SUNPILOT_LOG_LEVEL` | `info` | Log level |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_DATABASE_URL` | `postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot` | PostgreSQL connection string |
| `SUNPILOT_POSTGRES_PORT` | `5432` | Override Docker PostgreSQL host port |

### LLM Configuration

SunPilot supports up to two LLM backends selectable at runtime. The primary (DP) model is required; the secondary (Seed) model is optional.

#### Primary Model (DP)

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_DP_LLM_API_KEY` | (required) | API key for the primary model |
| `SUNPILOT_DP_LLM_BASE_URL` | Same as `SUNPILOT_LLM_BASE_URL` | API base URL |
| `SUNPILOT_DP_LLM_MODEL` | Same as `SUNPILOT_LLM_MODEL` | Model name |

Fallback variables (used when DP-specific vars are unset):

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_LLM_API_KEY` | — | Shared API key |
| `DEEPSEEK_API_KEY` | — | Alternative key name |
| `SUNPILOT_LLM_BASE_URL` | `https://api.deepseek.com` | Shared base URL |
| `SUNPILOT_LLM_MODEL` | `deepseek-v4-flash` | Shared model name |

#### Secondary Model (Seed / Volcengine Ark)

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_SEED_LLM_API_KEY` | — | API key (unset = secondary model disabled) |
| `SUNPILOT_SEED_LLM_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | Base URL |
| `SUNPILOT_SEED_LLM_MODEL` | `doubao-seed-2-0-lite-260428` | Model name |

### Embedding

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_EMBEDDING_DIMENSIONS` | `1536` | Embedding vector dimensions |
| `SUNPILOT_EMBEDDING_MODEL` | — | Override embedding model |

When no embedding API key is configured, SunPilot falls back to keyword/hash-based vectors for semantic search.

### Safety

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_SANDBOX_MODE` | `moderate` | Tool sandbox mode: `strict`, `moderate`, or `permissive` |

### Runtime Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `SUNPILOT_SKILL_TIMEOUT_MS` | `300000` (5 min) | Skill execution timeout |
| `SUNPILOT_SKILL_MAX_CONCURRENCY` | `4` | Max concurrent skill executions |
| `SUNPILOT_RATE_LIMIT_MAX` | `200` | Max requests per window |
| `SUNPILOT_RATE_LIMIT_WINDOW_MS` | `10000` | Rate limit window |

## Database

The project uses PostgreSQL 16 with `pgvector` for vector embeddings. Docker Compose provides a pre-configured instance:

```bash
docker compose up -d postgres
```

Default credentials: `sunpilot` / `sunpilot_dev_password` on `localhost:5432`, database `sunpilot`.

If the default port is occupied:

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

Migrations are included in `packages/storage/src/migrations/` and run automatically on daemon startup.

## CLI Commands

```bash
sun start              # Start the daemon (background)
sun start --foreground # Start the daemon (foreground, logs to stdout)
sun stop               # Stop the daemon
sun restart            # Restart the daemon
sun status             # Check daemon health
sun doctor             # Run diagnostics
sun logs               # Show recent daemon logs
sun logs --lines 200   # Show last 200 log lines
sun open               # Open the web UI in browser
```

## Development

```bash
pnpm build              # Build all packages
pnpm test               # Run all tests
pnpm typecheck          # Type-check all packages
pnpm lint               # Lint all packages
pnpm dev:daemon         # Start daemon in dev mode (hot reload)
pnpm dev:web            # Start web dev server (Vite)
```

### Running Tests

```bash
pnpm test                           # All tests
pnpm --filter @sunpilot/core test   # Core package tests only
pnpm --filter @sunpilot/daemon test # Daemon tests only
```

## API Endpoints

### Health

```bash
curl http://127.0.0.1:3737/healthz
curl http://127.0.0.1:3737/readyz
```

### Chat

```bash
curl -X POST http://127.0.0.1:3737/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Introduce SunPilot in one sentence."}'
```

### Conversations

```bash
curl http://127.0.0.1:3737/v1/conversations
```

### WebSocket

```
ws://127.0.0.1:3737/v1/ws
```

The WebSocket endpoint uses JSON-RPC 2.0 for real-time streaming of agent responses, run state changes, and events.

```bash
# Quick ping test
node --input-type=module -e '
  const ws = new WebSocket("ws://127.0.0.1:3737/v1/ws");
  ws.addEventListener("open", () => ws.send(JSON.stringify({
    jsonrpc: "2.0", id: "ping_1", method: "ping", params: {}
  })));
  ws.addEventListener("message", (e) => { console.log(e.data); ws.close(); });
'
```

## Reverse Proxy

For production deployments, place the daemon behind Nginx with TLS:

```nginx
server {
  server_name your-domain.com;

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

Add your domain to allowed origins:

```bash
export SUNPILOT_ALLOWED_ORIGINS=https://your-domain.com
```

## Developer Docs

Chinese-language documentation in `developer_docs/`:

- `developer_docs/guides/` — implementation guides, usage manuals, environment config
- `developer_docs/architecture/` — architecture reviews and engineering summaries
- `developer_docs/reference/` — reference material

## License

SunPilot is released under the [GNU Affero General Public License v3.0](LICENSE).

Copyright (C) 2026 Silence
