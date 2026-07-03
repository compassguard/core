# Compass docs

This folder contains the active product and migration documentation for **Compass MCP Guard**.

## Canonical source

- [`PRODUCT_CONSTITUTION.md`](PRODUCT_CONSTITUTION.md) is the product source of truth.
- Feature specs live in their own folders: `docs/<feature-name>/functional-spec.md`, `technical-spec.md`, and `task.json`.
- This repo uses `docs/` as the only canonical documentation tree. Do not create or mirror OpenSpec artifacts in `openspec/`.

## Active migration docs

| Area                      | Path                                                                 | Notes                                                                               |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Product constitution      | [`PRODUCT_CONSTITUTION.md`](PRODUCT_CONSTITUTION.md)                 | Canonical product definition for Compass MCP Guard.                                 |
| Migration proposal / plan | [`compass-monad-on-solana/`](compass-monad-on-solana/)               | High-level migration from the old Solana app into Compass MCP Guard.                |
| Wave 2 policy engine      | [`wave-2-policy-engine/`](wave-2-policy-engine/)                     | Functional/technical specs and tasks for the policy engine.                         |
| Wave 3 transfer gateway   | [`wave-3-transfer-behind-gateway/`](wave-3-transfer-behind-gateway/) | Transfer evaluation behind the execution gateway.                                   |
| Wave 3.5 legacy isolation | [`wave-3.5-legacy-isolation/`](wave-3.5-legacy-isolation/)           | Plan, inventory, and review notes for moving old chat-product code under `legacy/`. |
| Wave 4 MCP server         | [`wave-4-mcp-server/`](wave-4-mcp-server/)                           | First-party MCP server/tool boundary for Compass-controlled tools.                  |
| Wave 5 gateways           | [`wave-5-swap-gateway/`](wave-5-swap-gateway/), [`wave-5-conditional-gateway/`](wave-5-conditional-gateway/) | Swap and conditional-buy gateway specs.                                             |
| Wave 6 signer adapter     | [`wave-6-signer-adapter/`](wave-6-signer-adapter/)                   | Signer adapter boundary, local devnet signer, idempotency, and execute tool.        |
| Wave 7 MCP compatibility  | [`wave-7-mcp-compatibility/`](wave-7-mcp-compatibility/)             | Approved execution hardening first, then upstream/mirrored MCP compatibility.       |
| Wave 8 demo hardening     | [`wave-8-demo-hardening/`](wave-8-demo-hardening/)                   | Local demo runbook, redacted audit examples, and network readiness boundaries.      |
| Wave 9 LLM/MCP setup      | [`wave-9-llm-mcp-setup/`](wave-9-llm-mcp-setup/)                     | Specs for bounded LLM decision support and quick OpenCode MCP setup.                |
| Wave 10 two-tool MCP      | [`wave-10-two-tool-e2e-mcp/`](wave-10-two-tool-e2e-mcp/)             | Proposal for a simpler E2E MCP surface around transfer, swap, and safe read-only helpers. |
| Backend architecture      | [`back-architecture.html`](back-architecture.html)                   | Current post-Wave-3.5 backend modules, flow, spec gaps, tests, and debts.           |
| On-chain deployments      | [`onchain-deployments.md`](onchain-deployments.md)                   | Devnet program IDs and deployment notes.                                            |

## Next architecture TODOs

- [ ] Wave 10: collapse public MCP write surface toward `compass_transfer` and `compass_swap`.
- [ ] Keep safe read-only helper tools public only when they provide user value and do not expose sensitive or non-public data.
- [ ] Move simulation, guard-only, approval proof, transaction payload, and direct execution primitives behind Compass internals.
- [ ] Treat chat-based `userConfirmedRisk` as devnet/demo-only; block non-devnet execution until external approval exists.
- [ ] Define production approval outside chat/LLM, such as dashboard, Telegram, mobile, or wallet-native approval.
- [ ] Define future executor adapter contracts for wallets and downstream MCPs; keep Wave 9 local-signer-only.
- [ ] Preserve current swap provider/check model until a dedicated swap execution builder is designed.

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

OpenSpec is intentionally not used in this repository. If a future workflow needs OpenSpec, first decide whether to migrate the canonical docs instead of duplicating them.
