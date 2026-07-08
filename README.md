# Compass

Compass is the **execution firewall for AI agents on Solana**.

It sits between AI agents, MCP tools, wallets, and on-chain protocols. Before any sensitive crypto action is signed or executed, Compass validates intent, classifies the tool call, applies policy, simulates or decodes the transaction when needed, asks for human approval when required, and records the decision in an audit trail.

Compass is **not** another AI wallet. Wallets control signing. Compass controls whether an agent action should reach signing at all.

## Repository Shape

```
compass/
├── app/                  # Next.js landing page entrypoints
├── api/hosted/           # Vercel serverless entrypoint for hosted backend
├── back/
│   ├── guardrail/        # Execution gateway, policy, redaction, debug logger
│   ├── services/
│   │   ├── mcp/          # MCP proxy server (server/, proxy/, config/)
│   │   ├── domains/      # Transfer, swap, conditional gateways
│   │   └── support/      # Signer adapter
│   └── solana/           # Anchor programs (deployed on-chain)
├── hosted/               # Hosted backend (Hono app, evaluation, audit, LLM, policy)
├── shared/types/         # Shared contracts between back and hosted
├── scripts/              # Utilities (ticket orchestrator, test helpers)
├── docs/                 # Product specs, proposals, task plans
├── tickets/              # SDD ticket files
├── vercel.json           # Vercel rewrites for hosted backend
├── package.json
├── tsconfig.json
└── vitest.back.config.ts
```

## Quick Start

### Prerequisites

- Node.js 18+
- [Bun](https://bun.sh) (for the hosted backend runtime)
- Git

### Setup

```sh
git clone <repo-url>
cd compass
npm install
cp .env.example .env.local
```

Edit `.env.local` and fill at minimum:

- `SOLANA_RPC_URL` — defaults to devnet
- `AGENT_ACTION_GUARD_PROGRAM_ID` — the deployed Anchor program ID
- `COMPASS_HOSTED_API_KEY` — any string for local auth

### Run the Hosted Backend Locally

```sh
npm run hosted:dev
```

Verify it's alive:

```sh
curl localhost:3001/health
# {"status":"ok","timestamp":"..."}
```

### Per-email API credentials

Besides the shared `COMPASS_HOSTED_API_KEY`, each caller can obtain its own email-scoped
credential. This is **additive** — the shared key still gates `/v1/*` as before.

Mint a key (public, no auth):

```sh
curl -X POST localhost:3001/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
# {"email":"you@example.com","apiKey":"compass_..."}
```

Then use it as a bearer token on any `/v1/*` route:

```sh
curl -X POST localhost:3001/v1/verify \
  -H 'Authorization: Bearer compass_...' \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"transfer_sol","intent":{"kind":"transfer"}}'
```

Verdicts written on this path are attributed to the credential's email. Credentials persist
in the same Supabase referenced by `COMPASS_VERDICT_DB_URL` (in-memory when unset). A revoked
credential returns `401` on its next request.

### Run the MCP Server Locally

```sh
npm run mcp:dev
```

The MCP server communicates over stdio and requires a downstream MCP server configured. See `back/services/mcp/config/` for configuration.

### Install Compass MCP With npx

After the npm package is published, users can run Compass without cloning this repository.

Add this MCP entry to your client config:

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
        "COMPASS_HOSTED_API_URL": "https://your-vercel-preview.vercel.app/api/hosted",
        "COMPASS_HOSTED_API_KEY": "your-hosted-api-key"
      }
    }
  }
}
```

Replace `@your-downstream/mcp-server` with the MCP server Compass should protect.

For the current verified preview, use:

```txt
COMPASS_HOSTED_API_URL=https://solanahackathon-qf8nkder5-ramirocshubs-projects.vercel.app/api/hosted
```

Do not hardcode real API keys in committed config files. Use your MCP client's secret/env handling when available.

### Run Tests

```sh
npm run test:back
```

Full E2E user flow:

```sh
node scripts/test-user-flow.mjs
```

## Environment Variables

Copy `.env.example` to `.env.local` and set values for your environment.

### Solana

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Solana RPC endpoint (default: `https://api.devnet.solana.com`) |
| `AGENT_ACTION_GUARD_PROGRAM_ID` | On-chain Anchor program ID for action guard |
| `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE` | Path to wallet safety attestor keypair file |
| `WALLET_SAFETY_ATTESTOR_SECRET_KEY` | Wallet safety attestor secret key (base58) |
| `COMPASS_LOCAL_SIGNER_ENABLED` | Enable local signer for devnet demo |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY` | Local signer secret key (base58) |
| `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` | Local signer public key (optional validation) |

### Hosted Backend

| Variable | Description |
|----------|-------------|
| `COMPASS_HOSTED_PORT` | Port for the hosted backend (default: `3001`) |
| `COMPASS_HOSTED_API_KEY` | Shared API key for `/v1/*` auth (additive; per-email credentials also work) |
| `COMPASS_VERDICT_DB_URL` | Supabase Postgres URL backing both the verdict store and per-email credentials (unset ⇒ in-memory) |

### Hybrid Guard

| Variable | Description |
|----------|-------------|
| `COMPASS_HYBRID_GUARD_ENABLED` | Enable hybrid guard (local MCP + hosted backend, default: `true`) |
| `COMPASS_HOSTED_API_URL` | URL of the hosted backend (default: `http://localhost:3001`) |
| `COMPASS_HOSTED_TIMEOUT_MS` | Timeout for hosted backend calls (default: `5000`) |

### LLM Judge

| Variable | Description |
|----------|-------------|
| `COMPASS_LLM_DECISION_ENABLED` | Enable optional advisory LLM judge (default: `false`) |
| `COMPASS_LLM_PROVIDER` | LLM provider (default: `opencode-go`) |
| `COMPASS_LLM_MODEL` | Model name (default: `kimi-k2.5`) |
| `COMPASS_LLM_BASE_URL` | Chat completions endpoint URL |
| `COMPASS_LLM_API_KEY` | API key for the LLM provider (required for OpenAI) |
| `COMPASS_LLM_TIMEOUT_MS` | Timeout for LLM calls (default: `3000`) |

### LLM Router

| Variable | Description |
|----------|-------------|
| `COMPASS_LLM_ROUTER_ENABLED` | Enable tool call classification router (default: `false`) |
| `COMPASS_LLM_ROUTER_TIMEOUT_MS` | Timeout for router calls (default: `10000`) |

### Analytics

| Variable | Description |
|----------|-------------|
| `POSTHOG_API_KEY` | PostHog project API key for server-side events |
| `POSTHOG_HOST` | PostHog host (default: `https://us.i.posthog.com`) |
| `COMPASS_INSTALLATION_ID` | Installation identifier for analytics correlation |

### Debug

| Variable | Description |
|----------|-------------|
| `COMPASS_DEBUG` | Comma-separated debug modules: `proxy`, `policy`, `gateway`, `execution`, `interceptor`, `llm`, `signer`, `connection`, `audit` |

### Price / Fallback

| Variable | Description |
|----------|-------------|
| `FALLBACK_SOL_USD_PRICE` | Fallback SOL price when on-chain quote is unavailable (default: `140`) |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run the Next.js app (landing page) |
| `npm run build` | Production build for Next.js |
| `npm run start` | Start the production Next.js server |
| `npm run lint` | Lint `app`, `back`, `hosted`, and `shared` |
| `npm run test:back` | Run backend test suite (vitest) |
| `npm run test:watch` | Run backend tests in watch mode |
| `npm run hosted:dev` | Start the hosted Hono backend via Bun |
| `npm run mcp:dev` | Start the Compass MCP server (stdio) |
| `npm run mcp:install:opencode` | Install Compass as an OpenCode MCP tool |
| `npm run test:e2e` | Run E2E pipeline tests |
| `npm run test:e2e:verbose` | Run E2E pipeline tests with verbose output |
| `npm run ticket:process` | Process a pending SDD ticket |
| `npm run ticket:approve` | Approve a pending SDD ticket |
| `npm run ticket:status` | Show SDD ticket status |

## Testing

- **Unit / integration tests**: `npm run test:back` — runs vitest against `back/` and `hosted/`.
- **E2E user flow**: `node scripts/test-user-flow.mjs` — simulates a complete user interaction.
- **E2E pipeline**: `npm run test:e2e` — runs the full pipeline test suite.
- **Stdio note**: Tests that spawn MCP stdio processes can be flaky when run in parallel. If you see intermittent failures, try running tests sequentially or rerun the failed suite.

## Deployment

| Component | Target | How |
|-----------|--------|-----|
| Hosted backend | Vercel | `api/hosted/[[...route]].ts` serverless entrypoint + `vercel.json` rewrites. Deploy via Vercel CLI or git push. |
| MCP server | Local (stdio) | User runs `npm run mcp:dev`. Connects to downstream MCP servers via stdio. |
| Landing page | Vercel (same project) | Next.js app at root. The landing is a separate concern from the hosted API. |
| Anchor programs | Solana | `anchor deploy` from `back/solana/`. Deployed program ID set via `AGENT_ACTION_GUARD_PROGRAM_ID`. |

## Security Rules

- Critical operations must pass backend guardrails before signing/execution.
- `sign_and_send_transaction` style flows must be denied unless Compass built and approved the transaction.
- Missing evidence, unsafe policy state, or unverifiable high-risk actions must fail closed.
- The Compass backend must not hold or expose user private keys.

## Branch Policy

| Branch | Purpose |
|--------|---------|
| `main` | Stable. No migration work merges here without explicit approval. |
| `release/compass_migration` | Integration branch for the MCP Guard migration. |
| `feature/wave-<n>-<description>` | Per-feature branches. Branch from and merge back into `release/compass_migration`. |

## Source Of Truth

- [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md) — canonical product document.
- [`docs/`](docs/) — feature specs, technical designs, task plans.
