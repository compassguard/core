# Compass docs

This folder contains the active product and migration documentation for **Compass MCP Guard**.

## Canonical source

- [`PRODUCT_CONSTITUTION.md`](PRODUCT_CONSTITUTION.md) is the product source of truth.
- Feature specs live in their own folders: `docs/<feature-name>/functional-spec.md`, `technical-spec.md`, and `task.json`.
- Do not mirror the same proposal/spec/task in both `docs/` and `openspec/changes/` unless explicitly requested.

## Active migration docs

| Area | Path | Notes |
| ---- | ---- | ----- |
| Product constitution | [`PRODUCT_CONSTITUTION.md`](PRODUCT_CONSTITUTION.md) | Canonical product definition for Compass MCP Guard. |
| Migration proposal / plan | [`compass-monad-on-solana/`](compass-monad-on-solana/) | High-level migration from the old Solana app into Compass MCP Guard. |
| Wave 2 policy engine | [`wave-2-policy-engine/`](wave-2-policy-engine/) | Functional/technical specs and tasks for the policy engine. |
| Wave 3 transfer gateway | [`wave-3-transfer-behind-gateway/`](wave-3-transfer-behind-gateway/) | Transfer evaluation behind the execution gateway. |
| Wave 3.5 legacy isolation | [`wave-3.5-legacy-isolation/`](wave-3.5-legacy-isolation/) | Plan, inventory, and review notes for moving old chat-product code under `legacy/`. |
| On-chain deployments | [`onchain-deployments.md`](onchain-deployments.md) | Devnet program IDs and deployment notes. |

## What moved to `legacy/`

Wave 3.5 isolated the previous chat/wallet application under [`../legacy/`](../legacy/):

- `legacy/front/` — old React chat/wallet UI.
- `legacy/app/` — old App Router routes: `/home`, `/dynamic-reset`, and `/api/**`.
- `legacy/back/` — old chat-product backend services and tests.
- `legacy/docs/`, `legacy/sdd/`, `legacy/learning-explanations/` — historical docs and SDD artifacts.
- `legacy/scripts/` — old devnet/chat utility scripts.
- `legacy/public/architecture-explainer.html` — old Wallet Copilot branded static page.

The main tree must not import from `legacy/`. ESLint blocks this explicitly.

## Main-tree docs rule

Use this structure for new feature work:

```txt
docs/<feature-name>/
├── functional-spec.md
├── technical-spec.md
└── task.json
```

Use kebab-case feature names, for example `docs/mcp-tool-boundary/` or `docs/swap-behind-gateway/`.

Root-level docs should be only cross-cutting documents, indices, or historical files that remain relevant to the MCP Guard direction.
