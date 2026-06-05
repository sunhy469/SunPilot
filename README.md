# SunPilot

SunPilot is a daemon-first local business agent runtime. The current implementation follows the first-phase daemon/API/web/launcher architecture:

- Local daemon on `127.0.0.1:3737`
- Token-protected REST API and WebSocket JSON-RPC
- PostgreSQL state store, normally provided by the project Docker Compose service
- Workflow/Skill runtime with fixture echo workflow
- Approval flow, audit log, append-only events, and artifact storage
- Local React web product served by the daemon after build
- Minimal `sun` launcher

## Develop

```bash
pnpm install
docker compose up -d postgres
pnpm build
sun start
```

By default the daemon connects to:

```bash
postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot
```

The Compose service publishes the container PostgreSQL port to `localhost:5432`. If another local PostgreSQL service already uses that port, either stop it or run the container on another port:

```bash
SUNPILOT_POSTGRES_PORT=55432 docker compose up -d postgres
export SUNPILOT_DATABASE_URL=postgresql://sunpilot:sunpilot_dev_password@localhost:55432/sunpilot
```

The install step links the local launcher to `~/.local/bin/sun`, so local development uses compact commands:

```bash
sun status
sun open
sun stop
```

`sun open` uses `https://tradeagent.asia` by default. Override it for local or private deployments with:

```bash
export SUNPILOT_WEB_URL=http://127.0.0.1:3737
```

API smoke:

```bash
TOKEN=$(cat ~/.sunpilot/runtime/auth-token)
curl http://127.0.0.1:3737/healthz
curl -X POST http://127.0.0.1:3737/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"text":"run fixture echo workflow"},"workflowId":"fixture.echo"}'
```

## Agent Model

The core LLM provider is OpenAI-compatible and defaults to DeepSeek:

```bash
export SUNPILOT_LLM_BASE_URL=https://api.deepseek.com
export SUNPILOT_LLM_MODEL=deepseek-v4-flash
export SUNPILOT_LLM_API_KEY=your_api_key
```

`DEEPSEEK_API_KEY` is also accepted as a fallback secret name. Do not put the key in the repo; set it in your shell profile, process manager, or systemd environment.

## Reverse Proxy

This deployment trusts `https://tradeagent.asia` and `https://www.tradeagent.asia` by default, so the daemon can be started normally:

```bash
sun start
```

Nginx can proxy the domain to the local daemon:

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
  }
}
```
