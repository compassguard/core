# Proposal: Compass MCP Guard on Solana

## Decision summary

Continue the product in the existing `compass` repository.

`compass` is already the Solana-native implementation base: Dynamic wallet auth, Next.js app, backend-prepared unsigned transactions, frontend approval/signing, Solana guardrails, Anchor programs, swaps, conditional orders, balances, and transaction history.

`compass_monad` remains useful as a reference for the safety-runtime architecture, but the stronger and more current product source is now `docs/PRODUCT_CONSTITUTION.md`.

The product should move from “wallet copilot with guardrails” toward **Compass MCP Guard**: an execution firewall that sits between AI agents and on-chain tools, validates every sensitive action, and only lets safe or approved actions reach signing.

## Source of truth

This proposal uses:

1. `docs/PRODUCT_CONSTITUTION.md` — canonical product thesis and MVP direction.
2. Existing `compass` implementation — Solana app, guardrail services, approval/signing flow, and Anchor programs.
3. `../hackathon/compass_monad` — reference implementation for MCP/proxy safety concepts, not an implementation base for Solana.

## Product thesis

Compass is the **execution firewall for AI agents on Solana**.

AI agents are gaining access to wallets, MCPs, and on-chain tools. That is useful, but dangerous: a bad tool call, prompt injection, misunderstood intent, or unsafe transaction can move funds irreversibly.

Compass solves this by becoming the required control point before sensitive execution:

```txt
User intent
↓
Agent tool call
↓
Compass registry + policy + risk + simulation
↓
Human approval when needed
↓
Signer adapter
↓
Solana execution
↓
Audit log
```

The key product line from the constitution is:

> Wallets control signing. Compass controls agent execution.

## What changes from the previous proposal

The earlier proposal framed MCP/proxy as an optional later slice. The product constitution makes it the center of the MVP.

Updated direction:

- The repo decision stays the same: continue in `compass`.
- The product target becomes **Compass MCP Guard v0**.
- The current web app becomes the approval/signing/product surface for the gateway.
- Current Solana features remain preserved capabilities, but they should be reorganized behind reusable execution-gateway primitives.
- The first MVP should prove allow / require approval / deny for agent-triggered Solana actions.

## Why not continue primarily in `compass_monad`?

`compass_monad` contains strong architecture ideas, but its executable runtime is Monad/EVM-specific:

- EVM Wallet Agent tools are not Solana wallet-standard tools.
- ERC20 approvals and typed-data risks do not map directly to SPL authorities, delegates, Token-2022 extensions, PDAs, or Solana account ownership.
- Monad RPC evidence through `eth_call` / `eth_estimateGas` does not map to Solana `simulateTransaction`, recent blockhash, fee payer, compute budget, account locks, and transaction versioning.
- Solidity policy contracts do not replace the existing Anchor/PDA guard direction.
- Its dashboard is mocked and does not replace the current Solana app UX.

Use `compass_monad` as an architectural reference, not as the Solana codebase.

## Why continue in `compass`?

`compass` already has the expensive Solana pieces:

| Area                    | Current Compass asset                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Wallet UX               | Legacy references now isolated under `legacy/front/src/`                                                              |
| API boundary            | Legacy routes now isolated under `legacy/app/api/*`; new MCP/tool boundary is pending                                |
| Guardrail orchestration | New guard primitives in `back/services/*`; legacy chat orchestration in `legacy/back/services/chat.ts`                |
| Action tools            | Legacy tools now isolated under `legacy/back/services/tools/*`; new tool adapters are pending                         |
| Solana enforcement      | `back/solana/agent-action-guard/*`, `back/solana/conditional-escrow-buy/*`                                            |
| Product surface         | Landing at `/` plus temporary `/launch`; legacy chat product isolated under `legacy/`                                 |

Rebuilding those inside `compass_monad` would add risk and delay without improving product direction.

## Preserved capabilities

These current capabilities are baseline requirements:

1. **Self-custodial Solana signing**
   - Backend prepares unsigned transactions.
   - Frontend wallet signs/sends only after Compass guardrails.
   - Compass backend must not hold user private keys.

2. **Dynamic wallet auth and session boundary**
   - Keep existing Dynamic Solana auth and embedded/external wallet support.
   - Keep provider secrets and risk integrations server-side.

3. **Guarded transfer flow**
   - Preserve destination checks, risk scoring, policy/approval PDA derivation, wallet safety attestations, and guarded transfer semantics.

4. **Swap and quote flow**
   - Preserve Orca/Jupiter-style quote/swap capability, but move toward policy-aware transaction preparation, simulation, and risk classification.

5. **Conditional order flow**
   - Preserve conditional buy / escrow ideas as examples of policy-bound semi-autonomous execution.

6. **Wallet state UX**
   - Preserve balances, allocation/assets, network status, and transaction history as read-only or low-risk tools.

7. **On-chain guard programs**
   - Preserve Anchor/PDA guard direction for policies, approvals, attestations, and conditional execution.

## Compass MCP Guard ideas to import

Import these ideas from the constitution and Compass Monad reference:

1. **MCP Guard boundary**
   - Agent hosts connect to Compass, not directly to raw wallet tools.
   - Compass controls `tools/list` and `tools/call` exposure.

2. **Tool registry**
   - Every exposed tool has explicit semantics, schema, risk class, required evidence, and default decision.
   - Unknown mutating tools block by default.

3. **Tool classification**
   - Read-only: allow + log.
   - Preparation/simulation: allow + log.
   - Sensitive execution: policy + simulation + approval when needed.
   - Signing: high-risk; `sign_and_send_transaction` denied unless Compass built and approved it.

4. **Policy engine**
   - Human-readable rules for transfer limits, unknown recipients, slippage, unknown tokens, blocked programs, delegates, authority changes, and signer constraints.

5. **Risk engine**
   - Evaluate tool-level, intent-level, transaction-level, and wallet-level risk.

6. **Decision model**
   - `ALLOW`
   - `DENY`
   - `REQUIRE_HUMAN_APPROVAL`
   - `REQUIRE_SIMULATION`
   - `REQUIRE_POLICY_UPDATE`
   - `REQUIRE_ADDITIONAL_CONTEXT`

7. **Approval layer**
   - Explain action, protocol, risk, reasons, and approval/rejection options in plain language.

8. **Audit log**
   - Record action, agent, tool, arguments summary, policy, decision, risk score, approval status, signature/result, and redacted metadata.

9. **Signer adapters**
   - Start with a devnet/local signer only for controlled MVP work if needed.
   - Reuse Dynamic and Solana wallet-standard paths for serious demo and user-facing flows.

## MVP objective

Build **Compass MCP Guard v0** on top of the current Compass repo.

The MVP should prove that an AI agent can request Solana actions through Compass and Compass can:

1. allow safe read/preparation actions;
2. require approval for risky-but-allowed actions;
3. deny dangerous or unverifiable actions;
4. preserve self-custodial signing;
5. write useful audit records.

## MVP non-goals

Do not build:

- a new wallet;
- mobile app;
- voice UX;
- multi-chain support;
- enterprise compliance suite;
- full risk dataset;
- every Solana protocol integration;
- autonomy without approval;
- backend custody of user private keys.

Do not port Monad/EVM implementation details directly.

## Proposed delivery slices

Detailed migration plan lives in:

- `docs/compass-monad-on-solana/mvp-migration-plan.md`

High-level chain:

1. **Docs/product alignment** — README, proposal, constitution references, current-state cleanup.
2. **Execution gateway core** — decision model, registry types, policy schema, audit contracts.
3. **Current flows behind gateway** — transfer first, then swap, then conditional orders.
4. **Approval/signing hardening** — explicit signer adapter boundary and fail-closed semantics.
5. **MCP Guard v0** — `tools/list`, `tools/call`, compatibility-mode bridge for one Solana integration.
6. **Demo hardening** — allowed, approval-required, denied, prompt-injection examples.

## Review workload forecast

The documentation update should stay below the 400-line review budget per file where possible, but the full migration implementation will exceed 400 lines if done as one PR.

Use chained PRs:

| PR  | Scope                            | Review target                        |
| --- | -------------------------------- | ------------------------------------ |
| A   | Product/docs alignment           | Docs only                            |
| B   | Registry + decision model tests  | Backend unit tests first             |
| C   | Policy + audit contracts         | Backend unit tests first             |
| D   | Transfer behind gateway          | Backend tests + no UX regression     |
| E   | Swap behind gateway              | Backend tests + quote/swap parity    |
| F   | Conditional order behind gateway | Backend tests + existing flow parity |
| G   | MCP Guard v0                     | Disabled/isolated until demo ready   |
| H   | Demo/runbook hardening           | Docs + verification evidence         |

Split any PR forecasted over 400 changed lines before implementation.

## Risks and mitigations

| Risk                                         | Impact                            | Mitigation                                                                        |
| -------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Product drifts back into “AI wallet”         | Weak differentiation              | Keep constitution framing: execution firewall, not wallet.                        |
| MCP Guard bypass                             | Agent could call raw wallet tools | Document no-bypass setup; add future doctor/check; never expose raw signer tools. |
| Argument-only validation misses dangerous tx | Unsafe execution                  | Move toward unsigned transaction decode/simulation before signing.                |
| Too much approval friction                   | Users disable Compass             | Policy thresholds, allowlists, risk-based approval, conservative/balanced modes.  |
| Large chat service blocks migration          | Regression/review risk            | Extract one action at a time under strict TDD.                                    |
| Devnet assumptions look like production      | Unsafe product claims             | Keep devnet/mainnet boundaries explicit.                                          |
| Missing evidence for high-risk action        | Funds at risk                     | Fail closed.                                                                      |

## Acceptance criteria for this proposal

- [x] Uses `docs/PRODUCT_CONSTITUTION.md` as the product source of truth.
- [x] Keeps `compass` as the implementation base.
- [x] Reframes the target MVP as Compass MCP Guard v0.
- [x] Preserves current Solana wallet/signing/guardrail capabilities.
- [x] Separates product concepts from Monad/EVM implementation details.
- [x] Defines staged migration direction.
- [x] Uses only this docs artifact; no duplicated OpenSpec proposal copy.
- [x] Makes no product code changes.

## Next recommended action

Approve the MVP migration plan, then start PR A: product/docs alignment and current-state cleanup. After that, use strict TDD for gateway primitives and migrate one existing action at a time.
