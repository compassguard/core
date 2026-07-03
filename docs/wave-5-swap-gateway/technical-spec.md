# Wave 5a — Swap gateway technical spec

## Summary

Add a narrow swap gateway and MCP adapters on top of the existing Wave 4 registry/router. The implementation should copy the transfer gateway shape: contracts first, RED tests, gateway evaluation, then MCP registration and audit wiring.

## Proposed file layout

```txt
back/services/
├── swapGatewayContracts.ts   # types, reason constants, metadata contracts
├── swapGateway.ts            # evaluation, policy context, fingerprints, audit helpers
└── __tests__/swapGateway.test.ts
back/services/mcp/
├── mcpToolContracts.ts       # add tool names and approval metadata union
├── mcpToolRegistry.ts        # add quote_swap and guarded_swap_sol_usdc
└── mcpToolCallRouter.ts      # add quote/swap handlers
```

Keep contracts/types separate from behavior. Do not put runtime logic in `*Contracts.ts` files.

## Gateway contract

`EvaluateSwapGatewayInput` should include: `id`, `network`, `toolName`, `actorWallet`, `inputToken`, `outputToken`, `inputAmount`, `slippageBps`, `protocol`, `tokenKnown`, `tokenMint`, `createdAt`, optional `quoteUsd`, optional policy, and optional risk/oracle evidence.

`SwapGatewayEvaluation` should include classification, candidate, policy context, policy evaluation, metadata, `proposalEligible`, `requiresApprovalCard`, and optional fail-closed reason.

Metadata must include candidate id, candidate fingerprint, policy id, decision, reason codes, evaluated rules, classification reason codes, context fingerprint, and evaluated timestamp.

## Policy and evidence

- Reuse `policyEngine.evaluateAction` with `actionKind: "swap"`; swap policy checks already exist.
- Derive `amount_usd`, `slippage_bps`, `protocol`, `token_mint`, and `token_known` from validated inputs/evidence.
- Missing or invalid amount/slippage/protocol evidence must produce `REQUIRE_ADDITIONAL_CONTEXT`.
- Unknown token and unallowed protocol follow the conservative default policy.
- Optional oracle/deviation evidence may be added as metadata only if it stays small; do not port a large legacy guard in this slice.

## MCP routing

- `quote_swap` should classify as preparation/simulation and return quote data via the existing quote provider path when possible.
- `guarded_swap_sol_usdc` should classify with tool name `swap`, call `evaluateSwapGateway`, emit audit, and map policy decisions to existing MCP result builders.
- The existing deny-only `sign_and_send_transaction` path must remain unchanged.

## Tests

Minimum RED/GREEN tests:

1. Swap gateway returns `ALLOW` for known SOL/USDC, allowed protocol, amount and slippage within policy.
2. High slippage returns `REQUIRE_HUMAN_APPROVAL` with `SWAP_SLIPPAGE_EXCEEDS_LIMIT`.
3. Unknown token returns `REQUIRE_HUMAN_APPROVAL` with `SWAP_UNKNOWN_TOKEN`.
4. Missing slippage/protocol/amount returns `REQUIRE_ADDITIONAL_CONTEXT`.
5. MCP registry lists swap tools with correct risk metadata.
6. MCP router maps quote to `ALLOW` and guarded swap to policy outcomes.
7. No active `back/services` MCP/gateway module imports from `legacy/`.

## Review budget rule

Wave 5 was requested as a combined branch, but this spec is a separate review track. If swap implementation plus tests is forecast above 400 changed lines, pause after gateway+MCP policy slice and defer optional oracle/on-chain/proposal-builder work.
