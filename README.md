# Compass

Compass is the **execution firewall for AI agents on Solana**.

It sits between AI agents, MCP tools, wallets, and on-chain protocols. Before any sensitive crypto action is signed or executed, Compass validates intent, classifies the tool call, applies policy, simulates or decodes the transaction when needed, asks for human approval when required, and records the decision in an audit trail.

Compass is **not** another AI wallet. Wallets control signing. Compass controls whether an agent action should reach signing at all.

## Product direction

The canonical product source is:

- [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md)

Current positioning:

> Compass lets builders give AI agents crypto capabilities without giving those agents unchecked control over funds.

The MVP target is **Compass MCP Guard v0**:

1. AI host connects to Compass as its MCP/tool boundary.
2. Compass exposes only known safe or guarded tools.
3. Tool calls go through registry, policy, simulation/decoding, approval, signer adapter, execution, and audit.
4. Dangerous actions are denied, gated by policy, or sent to human approval before signing.

## What Compass does (today, after Wave 3.5)

| Capability              | Status                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Execution gateway       | ✅ Implemented in `back/services/executionGateway.ts` (Wave 1).                                            |
| Policy engine           | ✅ Conservative default policy + evaluator in `back/services/policy/` (Wave 2).                            |
| Transfer guard          | ✅ End-to-end SOL transfer evaluation in `back/services/transferGateway.ts` (Wave 3).                      |
| Audit log               | ✅ Bounded in-memory sink in `back/services/transferAuditLog.ts` (Wave 3).                                 |
| Wallet safety primitives| ✅ `back/services/walletSafetyValidation.ts` (shared with the on-chain guard).                            |
| On-chain guard programs | ✅ Anchor programs in `back/solana/agent-action-guard/` and `back/solana/conditional-escrow-buy/`.        |
| MCP server / tool boundary | ⏳ Pending. Wave 3 wired the transfer guard inside the legacy chat entrypoint; the dedicated tool boundary lives in a follow-up wave. |
| Signer adapter / risk engine / simulation | ⏳ Pending. Programs are deployed, integration with the Compass tool boundary will land in later waves.   |

## What Compass is not

Compass should not become:

- a wallet replacement;
- a DeFi chatbot;
- a custodian of funds;
- an identity layer for agents;
- a tool that lets LLM output execute transactions directly;
- a direct competitor to Phantom, Dynamic, Privy, or Turnkey.

Compass integrates with wallets and signer infrastructure. Its moat is agent-aware execution control: intent, policy, risk, simulation, approval, and audit.

## Repository shape

After Wave 3.5 the main tree only contains Compass MCP Guard pieces plus the public landing. The previous chat-product code lives isolated under `legacy/` for reference.

```txt
.
├── app/                  # Next.js entrypoints for the public landing
│   ├── route.ts          # GET / serves landing.html
│   ├── landing/route.ts  # redirect /landing -> /
│   ├── launch/route.ts   # temporary WIP app page for landing CTAs
│   ├── layout.tsx        # minimal root layout (no front/ CSS)
│   └── not-found.tsx
├── back/
│   ├── services/         # Execution gateway, policy engine, transfer guard, wallet safety,
│   │                     # on-chain approval, audit log, price providers, env/http helpers
│   └── solana/           # Anchor programs (agent-action-guard, conditional-escrow-buy)
├── docs/                 # PRODUCT_CONSTITUTION + migration plan + active wave specs
├── legacy/               # Isolated archive of the previous chat product (read-only reference)
├── public/               # Landing assets (compass-icon, needle-mascot, banners)
├── scripts/build-favicon.mjs
├── shared/               # Placeholder for cross-runtime shared contracts
├── landing.html          # Public landing page
├── package.json
├── tsconfig.json         # excludes legacy/
├── vitest.back.config.ts # excludes legacy/
├── vitest.config.ts      # excludes legacy/
└── eslint.config.js      # blocks imports from legacy/ via no-restricted-imports
```

The main tree never imports anything under `legacy/`. ESLint and tsconfig enforce that.

For details on `legacy/`, see [`legacy/README.md`](legacy/README.md) and the Wave 3.5 docs under [`docs/wave-3.5-legacy-isolation/`](docs/wave-3.5-legacy-isolation/).

## Runtime boundary today

```txt
Browser request → app/route.ts → landing.html (public landing)
Browser request → app/launch/route.ts → launch.html (temporary WIP app page)

AI agent / future MCP client →
  Compass tool boundary (pending dedicated entrypoint) →
    back/services/executionGateway      (classify)
    back/services/policy                (evaluate)
    back/services/walletSafetyValidation
    back/services/transferGateway       (guarded action)
    back/services/onchainApproval       (on-chain check)
    back/services/transferAuditLog      (lifecycle events)
  → unsigned tx returned for wallet to sign
```

Until the dedicated MCP boundary lands, the transfer guard primitives are reachable directly through the backend services and Anchor programs. The legacy `/api/chat` entrypoint that drove the previous app lives at `legacy/app/api/chat/` and is not served by the main tree.

## Documentation map

| Need                                  | Read                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Product constitution                  | [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md)                      |
| Compass MCP Guard migration plan      | [`docs/compass-monad-on-solana/`](docs/compass-monad-on-solana/)                    |
| Policy engine spec                    | [`docs/wave-2-policy-engine/`](docs/wave-2-policy-engine/)                          |
| Transfer behind gateway (current)     | [`docs/wave-3-transfer-behind-gateway/`](docs/wave-3-transfer-behind-gateway/)      |
| Legacy isolation plan and inventory   | [`docs/wave-3.5-legacy-isolation/`](docs/wave-3.5-legacy-isolation/)                |
| On-chain deployments / program IDs    | [`docs/onchain-deployments.md`](docs/onchain-deployments.md)                        |
| Legacy chat-product reference         | [`legacy/README.md`](legacy/README.md)                                              |

## Scripts

| Command                                             | What it does                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm install --registry=https://registry.npmjs.org` | Install dependencies.                                                         |
| `npm run dev`                                       | Run the Next.js app (currently only serves the public landing).               |
| `npm run build`                                     | Production build.                                                             |
| `npm run test:back`                                 | Backend tests for the Compass MCP Guard surface.                              |
| `npm run lint`                                      | Lint `app` and `back/services`.                                               |
| `npm run lint:legacy`                               | Optional: lint the isolated legacy tree.                                      |
| `npm run test:legacy`                               | Optional: run the legacy chat-product tests on demand.                        |
| `npm run bootstrap:conditional`                     | Legacy devnet bootstrap utility; runs `legacy/scripts/bootstrap-conditional-devnet.mjs`. |

`npm test` (front Vitest) currently has no targets because the React app moved to `legacy/`. The script stays for the day a fresh approval/inspection UI lands in the main tree.

## Security rules

- Critical operations must pass backend guardrails before signing/execution.
- `sign_and_send_transaction` style flows must be denied unless Compass built and approved the transaction.
- Missing evidence, unsafe policy state, or unverifiable high-risk actions must fail closed.
- The Compass backend must not hold or expose user private keys.
- Compass MCP Guard code must never import from `legacy/`. ESLint enforces this.

## Branching

- `main`: stable; does not receive Compass MCP Guard waves until explicitly approved.
- `release/compass_migration`: integration branch for the migration waves.
- `feature/wave-<n>-<description>`: per-wave branches. Always branch from and merge back into `release/compass_migration`, never `main`.

## Deployment

Deploy the repo root as one Next.js app.

```txt
Framework: Next.js
Root Directory: ./
Build Command: npm run build
```

After Wave 3.5, the deployed app serves the public landing at `/`, redirects `/landing` to `/`, and exposes a temporary `/launch` WIP page for landing CTAs. The previous `/api/*` and `/home` routes are not deployed because they live under `legacy/`.
