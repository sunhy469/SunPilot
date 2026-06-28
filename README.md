<p align="center">
  <img src="packages/web/public/logo.png" alt="SunPilot logo" width="180" />
</p>

<h1 align="center">SunPilot</h1>

<p align="center"><strong>Daemon-first local business agent runtime</strong></p>

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

SunPilot is a local-first AI agent product built around an always-on Fastify daemon. It combines a React chat workspace, a persistent multi-step agent runtime, an extensible skill system, PostgreSQL/pgvector storage, and an experimental PixiJS “Digital World” task view.

> Project status: active development (`0.1.0`). The main chat/agent path is implemented and tested; the Digital World and third-party skill isolation still contain experimental or MVP-level behavior.

## What works today

- Streaming chat over WebSocket JSON-RPC, with persisted conversations and messages.
- A stateful Agent Loop: context → intent → planning → tool selection → approval → execution → reflection → response → memory.
- Native OpenAI-compatible function calling plus guarded textual-call fallback.
- Runtime-selectable DP/DeepSeek and optional Seed/Volcengine Ark models.
- Message attachments, Aliyun OSS presigned uploads, and image-reference validation.
- PostgreSQL persistence for runs, events, steps, model/tool calls, approvals, artifacts, traces, memory, and Digital World state.
- Hybrid memory/context retrieval with embeddings, summaries, reranking, query expansion, and stale-summary detection.
- Local bearer-token protection, origin checks, rate limiting, permission modes, approvals, prompt-injection checks, and tool policy enforcement.
- `sun` CLI lifecycle and diagnostics commands.

## Architecture

```text
Browser / CLI / HTTP client
          |
          | HTTP + WebSocket JSON-RPC
          v
@sunpilot/daemon (Fastify, default 127.0.0.1:3737)
    |-- @sunpilot/api       transport adapters and routes
    |-- @sunpilot/platform  conversation and Digital World services
    |-- @sunpilot/core      AgentService and AgentLoopEngine
    |       |-- context, intent, planning, tools, reflection, response
    |       |-- memory, model routing, safety, approval, tracing
    |       `-- @sunpilot/skill-runner
    |-- @sunpilot/storage   PostgreSQL repositories + pgvector
    `-- @sunpilot/web       built React SPA served by the daemon
```

The daemon is the composition root. `protocol` owns shared contracts, `api` stays at the transport boundary, `platform` owns product services, and `core` owns agent behavior.

## Packages

| Package                  | Responsibility                                                              |
| ------------------------ | --------------------------------------------------------------------------- |
| `@sunpilot/protocol`     | Shared commands, events, schemas, message parts, and rich-card types        |
| `@sunpilot/storage`      | PostgreSQL repositories, migrations, paths, and test database context       |
| `@sunpilot/platform`     | Conversation and Digital World business services                            |
| `@sunpilot/core`         | Agent runtime, LLM providers, context/memory, tools, safety, and traces     |
| `@sunpilot/api`          | REST endpoints, WebSocket JSON-RPC, OSS adapter                             |
| `@sunpilot/daemon`       | Server lifecycle, dependency wiring, recovery, workers, metrics, static web |
| `@sunpilot/web`          | React 19 chat UI, settings, debugging UI, and PixiJS Digital World          |
| `@sunpilot/skill-sdk`    | Skill authoring contract and test helpers                                   |
| `@sunpilot/skill-runner` | Skill discovery, validation, permissions, and execution                     |
| `@sunpilot/launcher`     | `sun` / `sunpilot` process-management CLI                                   |

## Prerequisites

- Node.js `>=22.22.2 <23`
- pnpm `>=11.5.1 <12`
- Docker, or PostgreSQL 16 with `pgvector`
- An OpenAI-compatible chat API key

## Quick start

```bash
pnpm install
docker compose up -d postgres
pnpm build

# Required by the current daemon bootstrap path.
export SUNPILOT_LLM_API_KEY=your_deepseek_api_key

# Optional second model.
export SUNPILOT_SEED_LLM_API_KEY=your_volcengine_ark_api_key

sun start
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
sun open
```

Open `http://127.0.0.1:3737` directly if browser launching is unavailable. Migrations run automatically when the daemon opens the database.

If port `5432` is already occupied:

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

## Model configuration

The daemon currently bootstraps its required DP provider from the legacy/shared variables below. `SUNPILOT_DP_LLM_*` customizes the DP route, but `SUNPILOT_DP_LLM_API_KEY` alone does not satisfy `createDefaultLlmProvider()` during daemon startup; set `SUNPILOT_LLM_API_KEY` (or `DEEPSEEK_API_KEY`) as well.

| Variable                     | Default                       | Purpose                               |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| `SUNPILOT_LLM_API_KEY`       | —                             | Required default/DP provider key      |
| `DEEPSEEK_API_KEY`           | —                             | Fallback name for the same key        |
| `SUNPILOT_LLM_BASE_URL`      | `https://api.deepseek.com`    | Default OpenAI-compatible endpoint    |
| `SUNPILOT_LLM_MODEL`         | `deepseek-v4-flash`           | Default DP model                      |
| `SUNPILOT_DP_LLM_BASE_URL`   | shared value                  | DP route override                     |
| `SUNPILOT_DP_LLM_MODEL`      | shared value                  | DP route override                     |
| `SUNPILOT_DP_LLM_API_KEY`    | shared value                  | DP route key override after bootstrap |
| `SUNPILOT_SEED_LLM_API_KEY`  | —                             | Enables the optional Seed route       |
| `SUNPILOT_SEED_LLM_BASE_URL` | Volcengine Ark `/api/v3`      | Seed endpoint                         |
| `SUNPILOT_SEED_LLM_MODEL`    | `doubao-seed-2-0-lite-260428` | Seed model                            |

See [environment configuration](developer_docs/guides/环境变量配置说明.md) for the full list.

## CLI

```bash
sun start [--foreground] [--port 3737]
sun stop
sun restart [--port 3737]
sun status [--port 3737]
sun doctor [--port 3737]
sun logs [--lines 200]
sun open
```

Runtime files live under `~/.sunpilot` by default. The daemon writes its local bearer token to `~/.sunpilot/runtime/token` with mode `0600`.

## Development

```bash
pnpm dev:daemon
pnpm dev:web

pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

The Vite dev server runs on `127.0.0.1:3738`; the daemon runs on `127.0.0.1:3737`.

## API and authentication

`GET /healthz` and `GET /readyz` are unauthenticated. Other non-browser requests need the daemon token unless `SUNPILOT_DISABLE_TOKEN_AUTH=1` is explicitly used for local development.

```bash
TOKEN="$(<"${SUNPILOT_HOME:-$HOME/.sunpilot}/runtime/token")"

curl http://127.0.0.1:3737/healthz
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3737/v1/diagnostics

curl -X POST http://127.0.0.1:3737/v1/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Introduce SunPilot in one sentence."}'
```

The full browser chat path uses `ws://127.0.0.1:3737/v1/ws` and JSON-RPC methods such as `chat.send`, `chat.stop`, `run.cancel`, `run.resume`, `run.retry`, and approval decisions. The canonical streaming event is `agent.message.part.delta`.

## Important boundaries

- PostgreSQL is the only supported runtime database. Some path fields retain old local-store names for compatibility but are not active databases.
- Skills are imported into the daemon process. Filesystem, network, environment, timeout, and concurrency checks exist, and shell access is rejected, but this is not OS/container isolation.
- The Digital World has persistent services and an Agent-run bridge, but task templates are fixed and development mode can fall back to mock data.
- `/v1/chat` is a simple synchronous HTTP adapter. The WebSocket path exposes the complete model, permission, attachment, and streaming contract.

## Documentation

- [Current engineering summary](developer_docs/architecture/工程实现总结.md)
- [Architecture assessment](developer_docs/architecture/架构评测报告.md)
- [Command manual](developer_docs/guides/命令使用手册.md)
- [Environment variables](developer_docs/guides/环境变量配置说明.md)
- [Paths and files](developer_docs/guides/文件路径与作用说明.md)
- [Code responsibility index](developer_docs/reference/代码文件职责索引.md)
- [Skill specification](developer_docs/reference/Skill范式规范详细总结.md)

Developer documentation is written in Chinese and reflects the repository state as of 2026-06-28.

## License

[GNU Affero General Public License v3.0](LICENSE)

Copyright (C) 2026 Silence
