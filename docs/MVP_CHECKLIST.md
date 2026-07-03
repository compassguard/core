# MVP Checklist — Compass MCP Guard

## Infra & Deploy

- [x] Hosted backend en Vercel (`/health` 200)
- [x] Auth funciona (`/v1/evaluate` 200 con Bearer key)
- [x] Policies endpoint (`/v1/policies` 200)
- [x] Audit write/query (`/v1/audit/events` 200, `/v1/audits` 200)
- [x] POSTHOG_API_KEY en Vercel env

## MCP Server

- [x] MCP server stdio funcional (`npm run mcp:dev`)
- [x] `tools/list` passthrough desde downstream
- [x] `tools/call` interceptado por policy
- [x] Policy interceptor clasifica read-only / sensitive / signing / unknown
- [x] Hybrid guard routing a hosted backend
- [x] PostHog telemetry aislado de audit try/catch
- [x] Unknown tools pasan por LLM judge (no deny directo)

## Tests

- [x] 312/312 unit + integration
- [x] 12/13 E2E user flow (el 13° es audit trail local)
- [x] MCP server tests (15/15)
- [x] Hybrid e2e test

## Package & Distribución

- [x] `tsup` bundler → `dist/mcpServer.js` (40KB autocontenido)
- [x] `bin` field para `npx`
- [x] `@ramadan04/compass-mcp-guard` publicado en npm
- [x] README con paso a paso de instalación vía `npx`
- [x] Postman collection (`docs/hosted-api/compass-hosted.postman_collection.json`)

## Pendiente

- [ ] Demo en Claude / Cursor con config `mcpServers`
- [ ] Test read-only: "Check my wallet balance" → ALLOW
- [ ] Test transfer: "Send 1 SOL to new address" → REQUIRE_APPROVAL
- [ ] Test swap: "Buy memecoin with 2 SOL" → DENY

## Hosted API Preview

| URL | Status |
|-----|--------|
| `https://solanahackathon-qf8nkder5-ramirocshubs-projects.vercel.app` | ✅ Ready |

## npm Package

```sh
npx -y @ramadan04/compass-mcp-guard \
  --downstream-name solana-tools \
  --downstream-command npx \
  --downstream-args-json '["@your-downstream/mcp-server"]'
```

```json
{
  "mcpServers": {
    "compass": {
      "command": "npx",
      "args": [
        "-y",
        "@ramadan04/compass-mcp-guard",
        "--downstream-name",
        "solana-tools",
        "--downstream-command",
        "npx",
        "--downstream-args-json",
        "[\"@your-downstream/mcp-server\"]"
      ],
      "env": {
        "COMPASS_HYBRID_GUARD_ENABLED": "true",
        "COMPASS_HOSTED_API_URL": "https://solanahackathon-qf8nkder5-ramirocshubs-projects.vercel.app/api/hosted",
        "COMPASS_HOSTED_API_KEY": "compass-hc-3d87d61ea82d"
      }
    }
  }
}
```
