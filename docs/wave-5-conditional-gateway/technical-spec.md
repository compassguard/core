# Wave 5b — Conditional gateway technical spec

## Summary

Add a conditional order creation gateway behind the Wave 4 MCP boundary. The first implementation slice should validate and evaluate order creation only; signer adapter, unsigned transaction build, and keeper execution can be deferred if they threaten the 400-line budget.

## Proposed file layout

```txt
back/services/
├── conditionalGatewayContracts.ts   # types, reason constants, metadata contracts
├── conditionalGateway.ts            # evaluation, policy context, fingerprints, audit helpers
└── __tests__/conditionalGateway.test.ts
back/services/mcp/
├── mcpToolContracts.ts              # add conditional tool names/metadata type union
├── mcpToolRegistry.ts               # add create_conditional_buy_sol and optional simulation tool
└── mcpToolCallRouter.ts             # add conditional handlers
```

Keep type contracts separate from behavior. Do not import from `legacy/`; rederive only the minimal active-tree logic needed.

## Gateway contract

`EvaluateConditionalGatewayInput` should include: `id`, `network`, `toolName`, `actorWallet`, `inputToken`, `inputAmountUsdc`, `targetPriceUsd`, optional `desiredSolLamports`, `maxSlippageBps`, `oracleFeedPubkey`, `oraclePriceUsd`, `maxOracleAgeSeconds`, `maxConfidenceBps`, `recipient`, `expiresAtUnix`, `createdAt`, optional policy, and optional wallet/risk evidence.

`ConditionalGatewayEvaluation` should include classification, candidate, policy context, policy evaluation, metadata, `proposalEligible`, `requiresApprovalCard`, and optional fail-closed reason.

Metadata should mirror transfer/swap metadata: candidate id, candidate fingerprint, policy id, decision, reason codes, evaluated rules, classification reason codes, context fingerprint, and evaluated timestamp.

## Policy direction

Preferred implementation: add a minimal `conditional` policy contract and `evaluateConditionalBuy` branch in `policyEngine.ts`, with conservative defaults:

- default requires human approval for valid conditional order creation;
- missing amount/target/oracle/expiry/slippage context requires additional context;
- invalid amount, expired order, stale oracle, or unsafe oracle confidence denies or requires context;
- blocked flags continue to deny before conditional-specific checks.

If this exceeds budget, pause and ask before implementing local gateway-only policy logic.

## MCP routing

- `create_conditional_buy_sol` classifies as `conditional_buy_sol` and mutates.
- Optional `simulate_conditional_buy_oracle_check` classifies as preparation/simulation and must not create orders.
- Router must emit audit for all decisions and map results through existing MCP result builders.
- Direct signing/sending remains denied.

## Tests

Minimum RED/GREEN tests:

1. Valid conditional order creation returns policy-bound approval metadata and audit-safe data.
2. Missing oracle feed/target price/expiry returns `REQUIRE_ADDITIONAL_CONTEXT`.
3. Expired or invalid order input fails closed.
4. Amount over policy or default-sensitive creation returns `REQUIRE_HUMAN_APPROVAL`.
5. MCP registry/router expose and route conditional tools.
6. Optional oracle simulation is read/preparation only.
7. No active MCP/gateway module imports from `legacy/`.

## Deferred work

- Keeper polling/execution and recurring task management.
- Signer adapter and duplicate execution protection.
- Full unsigned transaction/PDA builder if it cannot fit in the review budget.
- Durable audit storage.

## Review budget rule

This track follows Wave 5a on the same combined branch but should remain independently reviewable. If swap work already consumes most of the 400-line budget, pause before coding conditional and split into a follow-up branch/PR.
