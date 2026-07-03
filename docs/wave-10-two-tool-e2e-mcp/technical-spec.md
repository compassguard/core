# Wave 10 Two-Tool E2E MCP Technical Spec

## Technical Approach

Collapse the public MCP write surface into two user-facing tools: `compass_transfer` and `compass_swap`. The existing internal guard/evaluate/build/execute steps are hidden behind these tools.

- `compass_transfer` parses input, runs the transfer gateway, handles devnet/demo approval (`userConfirmedRisk`), builds the unsigned transaction, executes it via the local signer adapter, and returns the result. On non-devnet it returns an explicit "external approval required" message without executing.
- `compass_swap` runs the existing swap gateway and returns the deterministic decision. It does **not** build or execute a transaction; instead it returns an explicit status that swap execution is pending a dedicated builder.
- Safe read-only helpers (`get_usdc_sol_quote`, `quote_swap`, `simulate_conditional_buy_oracle_check`) remain public.
- `execute_approved_action`, `sign_and_send_transaction`, and `create_conditional_buy_sol` are removed from the public MCP list. The execution logic is extracted into an internal function so `compass_transfer` can call it directly.

## Architecture Decisions

| Decision | Options | Tradeoffs | Choice |
|----------|---------|-----------|--------|
| Public tool names | Keep `guarded_transfer_sol` / `guarded_swap_sol_usdc` | Confusing; signals internal mechanics | Rename to `compass_transfer` / `compass_swap` |
| Approval gating | Separate `execute_approved_action` vs inline in the tool | Separate tool leaks orchestration to the agent | Inline in `compass_transfer`; non-devnet blocks with clear message |
| Swap execution | Fake a transaction vs return explicit unsupported | Faking is unsafe and misleading | Return explicit `SWAP_EXECUTION_PENDING_BUILDER` status |
| Execution logic reuse | Keep `execute_approved_action` as a public tool vs extract internal | Public tool exposes execution boundary | Extract `internalExecutor` module for `compass_transfer` to call |
| Conditional buy | Keep public vs hide | Proposal says only two public write tools | Hide from public list; keep router support internal if needed |
| Idempotency for E2E | Use `approvalIdempotencyStore` vs skip | Prevents duplicate execution if same candidate is retried | Consume idempotency right before signing, same as current flow |

## Data Flow

```
Agent -> compass_transfer
  -> parse input (incl. userConfirmedRisk)
  -> apply default actorWallet from local signer
  -> evaluateTransferGateway
  -> if DENY -> deny
  -> if REQUIRE_ADDITIONAL_CONTEXT -> request context
  -> if REQUIRE_HUMAN_APPROVAL:
       devnet + userConfirmedRisk -> continue
       devnet without -> ask confirmation
       non-devnet -> block (external approval required)
  -> buildSolTransferTransactionPayload
  -> internalExecutor.signAndSend (signerAdapter + idempotency)
  -> audit
  -> return signature / status

Agent -> compass_swap
  -> parse input (incl. userConfirmedRisk)
  -> evaluateSwapGateway
  -> return policy decision + executionPending message
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `back/services/mcp/mcpToolContracts.ts` | Modify | Rename `GUARDED_TRANSFER_SOL` -> `COMPASS_TRANSFER`, `GUARDED_SWAP_SOL_USDC` -> `COMPASS_SWAP`. Add `userConfirmedRisk?: boolean` to both schemas. |
| `back/services/mcp/mcpToolRegistry.ts` | Modify | Rename public write entries, remove `EXECUTE_APPROVED_ACTION`, `SIGN_AND_SEND_TRANSACTION`, and `CREATE_CONDITIONAL_BUY_SOL` from the public list. |
| `back/services/mcp/mcpToolCallRouter.ts` | Modify | Replace `handleTransferTool` with `handleCompassTransfer` (E2E flow). Replace `handleSwapTool` with `handleCompassSwap`. Remove public `execute_approved_action` routing. |
| `back/services/mcp/internalExecutor.ts` | Create | Extracted execution logic: parse payload, validate proof binding (for non-devnet), verify on-chain approval, consume idempotency, create signer, sign and send. |
| `back/services/__tests__/mcpToolRegistry.test.ts` | Modify | Assert public list contains only `compass_transfer`, `compass_swap`, read-only helpers, and conditional oracle check. |
| `back/services/__tests__/mcpToolCallRouter.test.ts` | Modify | Add E2E transfer tests (devnet success, non-devnet block, missing confirmation). Update swap tests for pending builder status. |

## Interfaces / Contracts

```typescript
// Added to mcpToolContracts.ts
export const MCP_TOOL_NAMES = {
  // ... existing read-only helpers ...
  COMPASS_TRANSFER: "compass_transfer",
  COMPASS_SWAP: "compass_swap",
  // Internal-only (not in public list):
  EXECUTE_APPROVED_ACTION: "execute_approved_action",
  SIGN_AND_SEND_TRANSACTION: "sign_and_send_transaction",
  CREATE_CONDITIONAL_BUY_SOL: "create_conditional_buy_sol",
} as const;

// New input schema for compass_transfer
const COMPASS_TRANSFER_SCHEMA = {
  // ... same as GUARDED_TRANSFER_SOL_SCHEMA ...
  properties: {
    // ...
    userConfirmedRisk: { type: "boolean" },
  },
};

// New input schema for compass_swap
const COMPASS_SWAP_SCHEMA = {
  // ... same as GUARDED_SWAP_SOL_USDC_SCHEMA ...
  properties: {
    // ...
    userConfirmedRisk: { type: "boolean" },
  },
};

// Internal execution input (used by internalExecutor.ts)
export type ExecuteMcpTransferInput = {
  candidateId: string;
  network: McpSupportedNetwork;
  transactionPayload: ExecuteApprovedActionTransactionPayload;
  approvalProof?: OnchainActionApprovalProof;
};
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Registry public list, router input parsing, internal executor idempotency | Vitest with mocked gateways and signer adapter |
| Integration | E2E devnet transfer with local signer, non-devnet transfer blocked, swap returns pending status | Vitest with mocked `Connection.sendRawTransaction` |
| E2E | Not required for this wave | — |

## Migration / Rollout

No data migration required. This is a breaking change to the public MCP surface. Clients/agents using `guarded_transfer_sol`, `guarded_swap_sol_usdc`, or `execute_approved_action` must update to `compass_transfer` and `compass_swap`.

## Open Questions

- [ ] Should `create_conditional_buy_sol` be completely removed from the registry or kept as an internal-only entry that the router can still handle? **Decision**: Hide from public list; keep router support internal if needed for backward compatibility during transition.
- [ ] Should `compass_transfer` consume idempotency before or after building the transaction? **Decision**: After building, right before signing, to avoid blocking retries on build failures.
- [ ] Should `compass_swap` return `ALLOW` with `executionPending` or a new `UNSUPPORTED` decision? **Decision**: Return the gateway decision (ALLOW/REQUIRE_HUMAN_APPROVAL/etc.) with `data.executionStatus: "pending_builder"` and a clear message. Do not add a new top-level decision.
