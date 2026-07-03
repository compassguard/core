# Wave 5b — Conditional gateway functional spec

## Summary

Wave 5b exposes conditional SOL buy order creation as a guarded Compass MCP tool. The feature lets an agent propose an order such as “buy SOL when price is at or below X”, but creation must remain policy-bound, approval-ready, and auditable. Keeper execution and signing are out of scope.

## Goals

- Represent conditional order creation through the first-party MCP boundary.
- Validate price-condition, oracle, expiry, amount, recipient, and slippage context before a proposal can be eligible.
- Route the sensitive action through a new conditional gateway and policy evaluation.
- Produce stable decision results and audit events for proposal creation or fail-closed rejection.
- Keep legacy conditional code as reference only; do not import from `legacy/`.

## Non-goals

- No keeper loop, recurring execution engine, or autonomous execution.
- No signer adapter, custody, or transaction submission; Wave 6 owns signer/idempotency.
- No UI rebuild for approvals in this slice.
- No upstream MCP passthrough.

## Tool set

| Tool | Risk class | Default behavior |
| --- | --- | --- |
| `create_conditional_buy_sol` | sensitive execution | Evaluate order creation through conditional gateway and policy. |
| `simulate_conditional_buy_oracle_check` | preparation/simulation | Optional small oracle/price evidence read; `ALLOW` + audit when evidence is available. |
| `sign_and_send_transaction` | signing | Remains `DENY` regression guard. |

## User-visible scenarios

1. Valid order proposal: amount, target price, expiry, oracle feed, and slippage evidence are present; Compass returns `REQUIRE_HUMAN_APPROVAL` or `ALLOW` according to policy, with proposal metadata and audit id.
2. Price condition not currently met: still proposal-eligible if the condition is valid and policy allows creation; execution is deferred.
3. Missing oracle/feed/target/expiry evidence: returns `REQUIRE_ADDITIONAL_CONTEXT` fail-closed.
4. Suspicious or impossible condition, invalid amount, expired order, or blocked flags: returns `DENY` or `REQUIRE_ADDITIONAL_CONTEXT` according to policy reason.
5. Direct signing/sending remains denied.

## Acceptance criteria

- Conditional order creation is exposed as a guarded MCP tool, not a legacy chat flow.
- The gateway creates an action candidate with `actionKind: "conditional_buy"` or an approved equivalent documented in implementation.
- Missing oracle, price-condition, amount, expiry, or recipient evidence fails closed.
- Audit metadata is redacted and includes policy id, evaluated rules, condition summary, oracle summary, and fingerprints.
- Keeper execution is explicitly not implemented.
- If combined Wave 5 implementation is forecast above 400 changed lines, pause and split before coding this track.

## Verification

- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`
- Manual MCP evidence for `tools/list`, `create_conditional_buy_sol`, optional oracle simulation, and direct-signing denial.
