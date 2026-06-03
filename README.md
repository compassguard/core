# Compass

Compass is the **execution firewall for AI agents on Solana**.

It sits between AI agents, MCP tools, wallets, and on-chain protocols. Before any sensitive crypto action is signed or executed, Compass validates intent, classifies the tool call, applies policy, simulates or decodes the transaction when needed, asks for human approval when required, and records the decision in an audit trail.

Compass is **not** another AI wallet. Wallets control signing. Compass controls whether an agent action should reach signing at all.

## Product direction

The canonical product source is:

- `docs/PRODUCT_CONSTITUTION.md`

Current positioning:

> Compass lets builders give AI agents crypto capabilities without giving those agents unchecked control over funds.

The MVP target is **Compass MCP Guard v0**:

1. AI host connects to Compass as its MCP/tool boundary.
2. Compass exposes only known safe or guarded tools.
3. Tool calls go through registry, policy, simulation/decoding, approval, signer adapter, execution, and audit.
4. Dangerous actions are denied, gated by policy, or sent to human approval before signing.

## What Compass does

| Capability              | Current role                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| MCP / execution gateway | Future MVP boundary for Claude, Cursor, Codex, and custom agents.                                   |
| Tool registry           | Defines which tools are read-only, preparatory, sensitive, or blocked.                              |
| Policy engine           | Applies limits, allowlists, deny rules, approval thresholds, and signer rules.                      |
| Risk engine             | Evaluates action type, amount, recipient, token/protocol, intent mismatch, and transaction effects. |
| Simulation / decoding   | Verifies unsigned Solana transactions before signature or execution.                                |
| Approval layer          | Shows clear explanations and lets a human approve/reject risky actions.                             |
| Signer adapter          | Keeps signing behind Compass-controlled approval instead of raw agent access.                       |
| Audit log               | Records decisions and outcomes for debugging, trust, and team workflows.                            |

## What Compass is not

Compass should not become:

- a wallet replacement;
- a DeFi chatbot;
- a custodian of funds;
- an identity layer for agents;
- a tool that lets LLM output execute transactions directly;
- a direct competitor to Phantom, Dynamic, Privy, or Turnkey.

Compass integrates with wallets and signer infrastructure. Its moat is agent-aware execution control: intent, policy, risk, simulation, approval, and audit.

## Current repository shape

This repo is a **Next.js fullstack app** with a clear physical split between frontend and backend logic.

```txt
.
├── app/                 # Next.js App Router pages and API route handlers
├── front/               # Browser UI, hooks, providers, stores, components
├── back/                # Server-side services, Solana logic, guardrails, programs
├── shared/              # Shared contracts/utilities
├── docs/                # Product docs, API docs, feature specs, migration plans
├── package.json
└── README.md
```

Runtime boundary today:

```txt
Browser / Agent surface
  -> app/api/* route handlers
    -> back/services/*
      -> Solana RPC / providers / Anchor programs
  -> frontend wallet path signs approved unsigned transactions
```

The backend prepares and validates unsigned transactions. The current product signing path remains the frontend wallet/Dynamic/Solana wallet flow after Compass approval. Future signer adapters must preserve that guarded boundary.

Primary app routes:

| Route            | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `/`              | Static landing page from `landing.html`.                     |
| `/home`          | Current Compass app UI from `front/src/App.tsx`.             |
| `/landing`       | Redirects legacy landing URL to `/`.                         |
| `/dynamic-reset` | Clears Dynamic wallet state and returns the user to `/home`. |
| `/api/*`         | Backend route handlers backed by `back/services/*`.          |

## Current Solana capabilities to preserve

The current Compass app already has Solana-native assets that the new product should reuse instead of rebuilding from scratch:

- Dynamic wallet auth and Solana wallet connectors.
- Backend-prepared unsigned transaction flow.
- Frontend wallet signing and approve/reject/result feedback.
- Guarded SOL transfer proposals.
- Orca USDC/SOL quote and guarded swap flow.
- Conditional SOL buy flow.
- Balance, allocation, network, and transaction-history panels.
- `agent-action-guard` Anchor program for policies, approvals, attestations, and guarded execution.
- `conditional-escrow-buy` Anchor program for oracle-triggered conditional orders.

## Target MVP migration

The migration target is documented in:

- `docs/compass-monad-on-solana/proposal.md`
- `docs/compass-monad-on-solana/mvp-migration-plan.md`

Short version:

1. Keep this repo as the Solana implementation base.
2. Reposition Compass around the product constitution: Agent Execution Security Gateway / MCP Guard.
3. Reuse the current app as approval/signing/product surface.
4. Add a Solana-native registry, policy, audit, digest, and guard pipeline.
5. Add MCP Guard v0 after the existing guarded flows are stable behind reusable services.

Branching rule for this migration:

- Keep `main` stable while the current app is still running there.
- Use `release/compass_migration` as the integration branch for the MVP migration.
- Use `feature/wave-<n>-<description>` branches for each wave.
- Merge wave branches into `release/compass_migration`, not into `main`, until explicitly approved.

## Documentation map

| Need                              | Read                                                 |
| --------------------------------- | ---------------------------------------------------- |
| Product constitution              | `docs/PRODUCT_CONSTITUTION.md`                       |
| Current proposal                  | `docs/compass-monad-on-solana/proposal.md`           |
| MVP migration plan                | `docs/compass-monad-on-solana/mvp-migration-plan.md` |
| API routes and contracts          | `docs/api-reference.md`                              |
| Scripts, tests, aliases, workflow | `docs/development-workflow.md`                       |
| Dynamic wallet auth               | `docs/dynamic-wallet-auth/`                          |
| Devnet/on-chain deployments       | `docs/onchain-deployments.md`                        |
| Feature spec index                | `docs/README.md`                                     |
| Frontend details                  | `front/README.md`                                    |
| Backend details                   | `back/README.md`                                     |
| Shared code                       | `shared/README.md`                                   |

## Scripts

| Command                                             | What it does                                  |
| --------------------------------------------------- | --------------------------------------------- |
| `npm install --registry=https://registry.npmjs.org` | Install dependencies.                         |
| `npm run dev`                                       | Run the full Next.js app.                     |
| `npm run build`                                     | Production build.                             |
| `npm test`                                          | Frontend/unit tests through Vitest.           |
| `npm run test:back`                                 | Backend/API tests.                            |
| `npm run lint`                                      | Lint `app`, `front/src`, and `back/services`. |
| `npm run bootstrap:conditional`                     | Bootstrap conditional escrow devnet state.    |

`dev:front`, `dev:back`, and `build:front` are convenience aliases; they do not represent separate deploys.

## Testing expectations

For future implementation, this repo uses strict TDD expectations from `openspec/config.yaml` and local project rules:

| Change type                 | Evidence            |
| --------------------------- | ------------------- |
| Frontend/UI                 | `npm test`          |
| Backend/API/guardrails      | `npm run test:back` |
| Runtime code                | `npm run lint`      |
| Route/config/global imports | `npm run build`     |

Do not implement product behavior without relevant tests first.

## Security rules

- Do not put private API keys or secrets in `front/`.
- Browser code must call internal `/api/*` routes for provider or RPC work that needs secrets.
- Critical operations must pass backend guardrails before signing/execution.
- `sign_and_send_transaction` style flows should be denied unless Compass built and approved the transaction.
- Missing evidence, unsafe policy state, or unverifiable high-risk actions should fail closed.
- Compass backend and MCP surfaces must not hold or expose user private keys.

## Deployment

Deploy the repo root as one Next.js app.

```txt
Framework: Next.js
Root Directory: ./
Build Command: npm run build
```

Do not deploy `front/` and `back/` separately. Next.js serves pages from `app/` and backend APIs from `app/api/*`.
