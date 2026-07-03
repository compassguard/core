# MVP migration plan: current Compass → Compass MCP Guard v0

## Goal

Migrate the current Solana Compass app into the MVP described by `docs/PRODUCT_CONSTITUTION.md`: **Compass MCP Guard v0**, an execution firewall for AI agents on Solana.

The migration should reuse the existing Compass app, guardrails, wallet approval flow, and Anchor programs. It should not restart from `compass_monad` and should not build a new wallet.

## Target MVP

Compass MCP Guard v0 should demonstrate three outcomes for agent-triggered Solana actions:

| Scenario                                            | Expected Compass decision              |
| --------------------------------------------------- | -------------------------------------- |
| Safe read/preparation                               | `ALLOW` + audit                        |
| Risky but policy-allowed action                     | `REQUIRE_HUMAN_APPROVAL` + explanation |
| Dangerous, unverifiable, or policy-forbidden action | `DENY` + reason                        |

Minimum demo set:

1. Read wallet balance or fetch quote → allowed.
2. Transfer to unknown recipient above threshold → requires approval.
3. Swap into unknown/high-risk token or prompt-injected transfer → denied.

## Product principles

From the constitution:

- Compass starts as **MCP Guard**, not as a wallet.
- Compass is wallet-agnostic at the execution boundary, not by magically intercepting every wallet.
- Dangerous tools pass through policy, simulation, approval, and signer adapter.
- Tools should not sign directly.
- `sign_and_send_transaction` should be denied unless Compass built and approved the transaction.
- The moat is protocol intelligence, risk data, policy templates, MCP distribution, audit, and signer adapters.

## Current assets to reuse

| Asset                                                     | Why it matters                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `legacy/front/src/hooks/useWallet.ts`                     | Legacy Solana signing/send path to study before building a new signer adapter.  |
| `legacy/front/src/hooks/useAgentMessage.ts`               | Legacy approve/reject/result loop to study before building the new approval UI. |
| `legacy/front/src/providers/DynamicWalletProvider.tsx`    | Legacy Dynamic Solana wallet auth reference.                                    |
| `legacy/back/services/chat.ts`                            | Legacy action proposal/orchestration entrypoint.                                |
| `legacy/back/services/tools/transfer.ts`                  | Legacy transfer validation baseline.                                            |
| `legacy/back/services/tools/orcaSwap.ts`, `orcaSwapTx.ts` | Legacy quote/swap baseline.                                                     |
| `legacy/back/services/tools/conditionalBuySol.ts`         | Legacy conditional execution baseline.                                          |
| `back/services/walletSafetyValidation.ts`                 | Existing risk/policy/attestation logic.                                         |
| `back/services/onchainApproval.ts`                        | PDA/on-chain approval logic.                                                    |
| `back/solana/agent-action-guard/*`                        | On-chain guard enforcement direction.                                           |
| `back/solana/conditional-escrow-buy/*`                    | Semi-autonomous conditional execution direction.                                |

## Architecture target

```txt
AI host / Web app / Future CLI
  ↓
Compass tool boundary
  ↓
Tool registry
  ↓
Policy engine
  ↓
Risk engine
  ↓
Simulation / decoder
  ↓
Decision engine
  ↓
Approval UI when needed
  ↓
Signer adapter
  ↓
Solana RPC / protocol / Anchor guard
  ↓
Audit log
```

## Branching model

Do not merge migration work directly into `main` yet. The current product should keep running from `main` while the migration is built and reviewed separately.

Use this branch structure:

| Branch                           | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `main`                           | Stable current Compass app. No migration wave merges unless explicitly approved later. |
| `release/compass_migration`      | Integration branch for the Compass MCP Guard migration. Every wave merges here first.  |
| `feature/wave-<n>-<description>` | Small feature branch for each wave or reviewable sub-slice.                            |

Rules:

1. Create every wave branch from `release/compass_migration`.
2. Merge wave branches back into `release/compass_migration`, not `main`.
3. Keep `main` untouched until the full migration is approved for release.
4. If a wave exceeds the 400-line review budget, split it into smaller feature branches that still target `release/compass_migration`.

Current first branch:

```txt
feature/wave-0-product-docs
```

## Migration waves

### Wave 0 — Product/docs alignment

Purpose: make the repo communicate the new product clearly before code changes.

Tasks:

- Update `README.md` around execution firewall / MCP Guard positioning.
- Update latest proposal using `docs/PRODUCT_CONSTITUTION.md`.
- Keep single-source docs policy from `AGENTS.md`: no mirrored OpenSpec copy.
- Identify stale docs claims, especially app route and wallet/auth assumptions.

Acceptance:

- Product docs say Compass is an execution firewall, not a wallet.
- `docs/PRODUCT_CONSTITUTION.md` is referenced as product source of truth.
- Proposal and README agree on MVP direction.

Verification:

- Docs review only.
- No product code changes.

### Wave 1 — Execution gateway contracts

Purpose: introduce backend primitives without changing current behavior.

Tasks:

- Define decision enum:
  - `ALLOW`
  - `DENY`
  - `REQUIRE_HUMAN_APPROVAL`
  - `REQUIRE_SIMULATION`
  - `REQUIRE_POLICY_UPDATE`
  - `REQUIRE_ADDITIONAL_CONTEXT`
- Define tool risk classes:
  - read-only;
  - preparation/simulation;
  - sensitive execution;
  - signing;
  - blocked/unknown.
- Define canonical action candidate shape for Solana actions.
- Define audit event shape with redaction rules.
- Add backend tests first.

Acceptance:

- Unknown mutating tools default to `DENY`.
- Read-only tools can be classified as `ALLOW + audit`.
- Signing tools are high-risk by default.
- No existing app behavior changes yet.

Verification:

- `npm run test:back`
- `npm run lint` if runtime files change.

### Wave 2 — Policy engine v0

Purpose: encode MVP policies from the constitution.

Tasks:

- Add policy schema for:
  - transfer max without approval;
  - unknown recipient approval;
  - swap slippage limit;
  - unknown token approval/deny;
  - blocked programs/recipients;
  - `sign_and_send_transaction` deny unless Compass-built.
- Add conservative default policy.
- Add tests for allow / approval / deny outcomes.

Acceptance:

- Policy decisions are deterministic and explainable.
- Missing policy evidence fails closed for sensitive actions.
- Policies are easy to version and inspect.

Verification:

- `npm run test:back`

### Wave 3 — Transfer behind gateway

Purpose: migrate the safest existing mutating flow first.

Tasks:

- Route transfer proposal evaluation through the new registry/policy/decision path.
- Preserve existing unsigned transaction and wallet signing flow.
- Preserve current wallet safety validation and on-chain guard semantics.
- Add audit events for transfer proposal, approval, submission, and result.

Acceptance:

- Existing transfer UX still works.
- Unknown/high-amount recipients require approval or deny according to policy.
- No transfer can sign/send without Compass approval path.

Verification:

- Red test first for transfer decision behavior.
- `npm run test:back`
- `npm test` if UI behavior changes.

### Wave 4 — MCP server and tool boundary

Purpose: expose the existing Compass guard core as the agent-facing boundary before adding more flows.

Why this was promoted: after Wave 3.5, `back/services/*` is a clean MCP Guard core but no active entrypoint consumes it. Swap/conditional work should not be added until agents can only reach guarded tools through Compass.

Tasks:

- Add a local TypeScript MCP server entrypoint or isolated module.
- Implement `tools/list` for first-party Compass tools.
- Implement `tools/call` interception for the initial tool set:
  - read/preparation tool: quote or safe read;
  - guarded mutating tool: transfer evaluation through `evaluateTransferGateway`;
  - blocked signing tool: direct `sign_and_send_transaction` style call.
- Add a minimal tool registry and adapter boundary that does not import from `legacy/`.
- Emit audit events for allow / require approval / deny decisions.
- Keep external upstream MCP passthrough out of scope unless explicitly isolated and tested.

Acceptance:

- An AI host or MCP test harness can call Compass `tools/list`.
- `tools/call` can return at least one `ALLOW`, one `REQUIRE_HUMAN_APPROVAL`, and one `DENY` outcome.
- Mutating actions go through policy/approval checks and cannot directly access raw signer tools.
- No `legacy/` import is introduced.

Verification:

- Backend tests for registry, list, call interception, and fail-closed behavior.
- `npm run test:back`
- `npm run lint`
- Manual local evidence for `tools/list` and the three `tools/call` outcomes when the server entrypoint exists.

### Wave 5 — Swap and conditional flows behind gateway

Purpose: apply the same model to higher-risk existing flows after the MCP/tool boundary exists.

Tasks:

- Migrate swap quote/swap proposal through registry/policy/risk/simulation decisions.
- Migrate conditional order creation through policy and audit.
- Add slippage, unknown token, protocol allowlist, and oracle/price-condition checks.
- Tighten fail-closed behavior when evidence is missing.

Acceptance:

- Existing swap and conditional order capabilities are represented as guarded tools, not legacy chat flows.
- High-slippage or unknown-token actions deny or require approval based on policy.
- Conditional execution remains policy-bound and auditable.

Verification:

- `npm run test:back`
- `npm run lint`

### Wave 6 — Approval and signer adapter boundary

Purpose: make signing rules explicit and future-proof.

Tasks:

- Define `SignerAdapter` boundary for Solana.
- Keep Dynamic/current wallet path as primary user-facing signer path.
- Add devnet LocalKeypairAdapter only if needed for local MCP demo, never as product custody.
- Deny direct `sign_and_send_transaction` unless Compass built and approved the transaction.
- Add duplicate approval / idempotency protection.

Acceptance:

- Compass backend does not hold user private keys.
- Signer path is explicit and test-covered.
- Duplicate approvals cannot accidentally double-execute.

Verification:

- `npm run test:back`
- `npm test` if approval UI changes.

### Wave 7 — MCP compatibility and upstream hardening

Purpose: extend the Wave 4 first-party MCP server into compatibility mode for mirrored or upstream tools.

Tasks:

- Add upstream MCP client integration only after first-party tools are stable.
- Mirror a small allowlisted external tool set behind Compass-prefixed names.
- Add no-bypass setup docs for Claude/Cursor/Codex-style clients.
- Keep unsafe upstream signer tools blocked unless Compass built and approved the action.
- Add redacted audit examples for upstream/mirrored tools.

Acceptance:

- An AI host can use Compass as the configured MCP server rather than connecting directly to raw execution MCPs.
- Mirrored read/preparation tools can be allowed and audited.
- Mirrored mutating tools still pass through policy/approval.
- Unsafe or unknown upstream tools block by default.

Verification:

- Backend tests for upstream registry/interceptor behavior.
- `npm run test:back`
- `npm run lint`
- Manual demo evidence for compatibility-mode `tools/list` and `tools/call`.

### Wave 8 — Demo hardening

Purpose: make the MVP reviewable and demoable.

Tasks:

- Create demo runbook:
  - allowed read;
  - approval-required transfer;
  - denied risky swap or prompt injection.
- Add audit examples with redacted metadata.
- Add clear failure messages and suggested actions.
- Reconcile devnet/mainnet status in docs.

Acceptance:

- Demo can be run end-to-end without reading secrets.
- The product story is clear: Compass blocks unsafe execution, not just chat suggestions.
- Mainnet readiness is not overstated.

Verification:

- `npm run test:back`
- `npm test` if UI changed.
- `npm run lint`
- `npm run build` if routes/config changed.

## Chained PR strategy

Do not implement this as one PR. Use chained PRs because the full migration will exceed the 400-line review budget.

All PRs in this chain should target `release/compass_migration`, not `main`.

| PR   | Branch example                       | Wave    | Base branch                 | Notes                        |
| ---- | ------------------------------------ | ------- | --------------------------- | ---------------------------- |
| PR A | `feature/wave-0-product-docs`        | Wave 0  | `release/compass_migration` | Docs/product alignment only. |
| PR B | `feature/wave-1-gateway-contracts`   | Wave 1  | `release/compass_migration` | Gateway contracts and tests. |
| PR C | `feature/wave-2-policy-engine`       | Wave 2  | `release/compass_migration` | Policy engine v0 and tests.  |
| PR D | `feature/wave-3-transfer-gateway`    | Wave 3  | `release/compass_migration` | Transfer migration.          |
| PR E | `feature/wave-4-mcp-server`          | Wave 4  | `release/compass_migration` | MCP server/tool boundary.    |
| PR F | `feature/wave-5-swap-gateway`        | Wave 5a | `release/compass_migration` | Swap migration.              |
| PR G | `feature/wave-5-conditional-gateway` | Wave 5b | `release/compass_migration` | Conditional order migration. |
| PR H | `feature/wave-6-signer-idempotency`  | Wave 6  | `release/compass_migration` | Signer adapter/idempotency.  |
| PR I | `feature/wave-7-mcp-compatibility`   | Wave 7  | `release/compass_migration` | Upstream MCP compatibility.  |
| PR J | `feature/wave-8-demo-hardening`      | Wave 8  | `release/compass_migration` | Demo hardening and runbook.  |

Split any PR forecasted over 400 changed lines before implementation.

## Open decisions

| Decision              | Options                                                                | Recommended default                                                                              |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| First MCP integration | Current Compass tools, Solana Agent Kit MCP, Phantom MCP, Jupiter flow | Current Compass tools first; fewer external unknowns.                                            |
| Local signer for MVP  | No local signer, LocalKeypairAdapter devnet, Dynamic only              | Dynamic/current wallet for product; LocalKeypairAdapter only for isolated devnet demo if needed. |
| Policy storage        | Local YAML, DB, on-chain PDA, hybrid                                   | Local YAML for MVP; evaluate on-chain/hybrid after gateway proves value.                         |
| Approval UI           | Current web app, CLI prompt, new local UI                              | Current web app first.                                                                           |
| Audit storage         | JSONL, DB, hosted logs                                                 | JSONL/local structured events for MVP.                                                           |

## Non-goals during MVP migration

- Do not build a new wallet.
- Do not add multi-chain support.
- Do not add enterprise compliance/export features.
- Do not give the backend custody of user private keys.
- Do not let raw MCP/wallet tools bypass Compass.
- Do not rewrite all existing flows before proving transfer behind the gateway.
- Do not claim mainnet readiness until provider, policy, deployment, and rollback plans are explicit.

## First implementation slice after docs

Start with **Wave 1: Execution gateway contracts**.

Minimum first TDD target:

1. Red tests for classifying:
   - read-only balance tool → `ALLOW`;
   - unknown mutating tool → `DENY`;
   - transfer above threshold → `REQUIRE_HUMAN_APPROVAL`;
   - direct sign/send → `DENY`.
2. Implement minimal types and classifier.
3. Add conservative default policy fixture.
4. Keep current app behavior unchanged.

This creates the foundation for migrating transfer without destabilizing the current product.
