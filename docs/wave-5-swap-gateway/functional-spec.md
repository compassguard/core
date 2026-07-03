# Wave 5a — Swap gateway functional spec

## Summary

Wave 5a exposes swap quote and swap proposal capabilities as first-party Compass MCP tools. Swap calls must pass through the same registry, classification, policy, risk/evidence, approval, and audit boundary established in Wave 4.

## Goals

- Represent swap quote/preparation and guarded swap proposal through `tools/list` and `tools/call`.
- Route sensitive swap proposals through a new swap gateway that mirrors the Wave 3 transfer gateway pattern.
- Enforce policy checks for slippage, amount, token familiarity, protocol allowlist, and missing evidence.
- Return stable `ALLOW`, `REQUIRE_HUMAN_APPROVAL`, `DENY`, or `REQUIRE_ADDITIONAL_CONTEXT` results with audit ids and redacted metadata.
- Keep swap behavior first-party; do not import from or depend on `legacy/`.

## Non-goals

- No signer adapter or transaction submission; Wave 6 owns signer/idempotency.
- No upstream MCP/Jupiter/Solana-Agent-Kit passthrough; Wave 7 owns compatibility mode.
- No broad multi-token swap engine beyond the initial SOL/USDC-oriented MVP surface unless it stays inside budget.
- No durable audit storage requirement.

## Tool set

| Tool | Risk class | Default behavior |
| --- | --- | --- |
| `quote_swap` | preparation/simulation | `ALLOW` + audit when quote inputs are valid. |
| `guarded_swap_sol_usdc` | sensitive execution | Evaluate through swap gateway and policy; may allow, require approval, deny, or ask for context. |
| `sign_and_send_transaction` | signing | Remains `DENY` regression guard. |

## User-visible scenarios

1. Safe quote: valid quote input returns `ALLOW` with quote data and audit id.
2. Low-risk swap proposal: known token, allowed protocol, amount and slippage within policy returns `ALLOW` plus proposal/approval metadata.
3. High-slippage swap: slippage above policy returns `REQUIRE_HUMAN_APPROVAL` with `SWAP_SLIPPAGE_EXCEEDS_LIMIT`.
4. Unknown token or unallowed protocol: returns `REQUIRE_HUMAN_APPROVAL` or `DENY` according to policy and evidence.
5. Missing amount, slippage, protocol, or token evidence: returns `REQUIRE_ADDITIONAL_CONTEXT` fail-closed.
6. Direct signing: raw signing/sending remains denied.

## Acceptance criteria

- Swap tools are listed as Compass-controlled tools and are not legacy chat tools.
- Sensitive swap calls create an action candidate with `actionKind: "swap"` and call `evaluateAction` through the swap gateway.
- Policy reason codes are stable and machine-readable.
- Audit records include policy id, evaluated rules, fingerprints, protocol/slippage summary, and no raw transaction/prompt/secret data.
- Backend tests cover allow, approval, missing-context, deny/regression, and no-legacy-import cases.
- If the implementation forecast exceeds 400 changed lines, stop after the smallest green slice and split follow-up work.

## Verification

- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`
- Manual MCP evidence for `tools/list`, `quote_swap`, high-risk `guarded_swap_sol_usdc`, and direct-signing denial.
