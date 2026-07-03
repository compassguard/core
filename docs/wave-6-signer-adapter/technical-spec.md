# Wave 6 — Signer adapter boundary and idempotency technical spec

Wave 6 introduces the explicit signing boundary for Compass MCP Guard. The implementation follows the current `task.json`: candidate-ID based execution boundary now, full on-chain approval proof verification and real transaction signing in Wave 7.

## Architecture

```txt
MCP client
  -> execute_approved_action tool call
    -> parse candidateId + optional network
      -> ApprovalIdempotencyStore.consume(candidateId)
        -> createSignerAdapter({ rpcUrl })
          -> DENY if no devnet local signer is configured
          -> ALLOW signer boundary metadata when local signer is configured
        -> emit MCP audit event
```

The backend does not instantiate a signer unless `COMPASS_LOCAL_SIGNER_ENABLED=true` is explicitly set. Production remains signer-free.

## Files

| File | Role |
| --- | --- |
| `back/services/signerAdapterContracts.ts` | `SignerAdapter` interface and factory result types. |
| `back/services/signerAdapter.ts` | `LocalKeypairAdapter` and `createSignerAdapter` devnet guard. |
| `back/services/approvalIdempotencyStore.ts` | In-memory consume-once candidate ID store. |
| `back/services/mcp/mcpToolContracts.ts` | Adds `EXECUTE_APPROVED_ACTION`. |
| `back/services/mcp/mcpToolRegistry.ts` | Registers `execute_approved_action` as a signing-risk tool. |
| `back/services/mcp/mcpToolCallRouter.ts` | Routes execute calls through parsing, idempotency, signer config, and audit. |
| `back/services/executionGateway.ts` | Classifies `execute_approved_action` as a signing tool with `APPROVED_ACTION_EXECUTION`. |

## Signer Adapter Contract

`SignerAdapter` lives in a contracts file, separate from implementation:

```ts
export interface SignerAdapter {
  getAddress(): Promise<string>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signAndSendTransaction?(tx: VersionedTransaction): Promise<string>;
}
```

`createSignerAdapter` returns a discriminated result:

```ts
type CreateSignerAdapterResult =
  | { ok: true; adapter: SignerAdapter }
  | { ok: false; reason: "LOCAL_SIGNER_NOT_CONFIGURED" | "LOCAL_SIGNER_MAINNET_FORBIDDEN" };
```

Guard rules:

- If `COMPASS_LOCAL_SIGNER_ENABLED !== "true"`, return `LOCAL_SIGNER_NOT_CONFIGURED`.
- If the configured RPC URL contains `mainnet`, return `LOCAL_SIGNER_MAINNET_FORBIDDEN`.
- If no local secret key is provided, return `LOCAL_SIGNER_NOT_CONFIGURED`.
- Never expose the secret key through MCP results, audit events, logs, or adapter methods.

## Idempotency Store

`ApprovalIdempotencyStore` is an in-memory singleton per server process:

```ts
export interface ApprovalIdempotencyStore {
  consume(candidateId: string): ConsumeResult;
  has(candidateId: string): boolean;
  clear(): void;
}
```

Semantics:

- First `consume(candidateId)` returns `{ ok: true }`.
- Repeated `consume(candidateId)` returns `{ ok: false, reason: "DUPLICATE_APPROVAL_EXECUTION" }`.
- A different candidate ID can still be consumed.
- `clear()` exists for test teardown.
- No TTL or durable persistence in Wave 6.

## MCP Tool

`execute_approved_action` schema:

```ts
{
  type: "object",
  properties: {
    candidateId: { type: "string" },
    network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] }
  },
  required: ["candidateId"],
  additionalProperties: false
}
```

Registry metadata:

- `riskClass: SIGNING`
- `executionKind: SENSITIVE_EXECUTION`
- `readOnly: false`
- `mutates: true`
- `actionKind: "execute_approved_action"`

Router behavior:

1. Validate `candidateId` is a non-empty string.
2. Return `REQUIRE_ADDITIONAL_CONTEXT` with `INVALID_EXECUTE_APPROVED_ACTION_INPUT` for invalid input.
3. Consume the candidate ID from `defaultApprovalIdempotencyStore`.
4. Return `DENY` with `DUPLICATE_APPROVAL_EXECUTION` on repeat calls before signer lookup.
5. Create the signer adapter for the requested network.
6. Return `DENY` with `LOCAL_SIGNER_NOT_CONFIGURED` or `LOCAL_SIGNER_MAINNET_FORBIDDEN` when signer setup is unavailable or unsafe.
7. Return `ALLOW` with `{ candidateId, signerPath: "local_keypair" }` only when the local devnet signer boundary is configured.
8. Emit an audit event for every outcome.

## Audit Metadata

`execute_approved_action` audit events include:

- `candidateId`
- `duplicateBlocked`
- `approvalVerified: false` in Wave 6
- `signerPath: "local_keypair" | "not_reached"`

Audit events must not include raw transactions, private keys, secret material, or raw prompts.

## Direct Signing Denial

`sign_and_send_transaction` remains deny-only. The deny message points callers to the approved path:

```txt
Compass blocks direct sign_and_send_transaction. Route actions through guarded_transfer_sol, guarded_swap_sol_usdc, or create_conditional_buy_sol, then call execute_approved_action with the gateway candidate ID.
```

## Tests

Wave 6 coverage includes:

- Signer adapter contract shape.
- Local signer env gate.
- Mainnet RPC rejection.
- Address derivation from test keypair.
- Secret-key non-exposure checks.
- Idempotency first-consume, duplicate-consume, different-ID, `has()`, and `clear()` behavior.
- MCP registry exposure for `execute_approved_action`.
- Direct `sign_and_send_transaction` denial regression.
- Missing candidate ID handling.
- Duplicate candidate denial before signer lookup.
- Missing local signer denial.
- MCP server tools/list exposure.
- Legacy import guard.

## Verification Status

- `npm run test:back -- back/services/__tests__/signerAdapter.test.ts back/services/__tests__/approvalIdempotencyStore.test.ts back/services/__tests__/mcpToolRegistry.test.ts back/services/__tests__/mcpToolCallRouter.test.ts back/services/__tests__/mcpServer.test.ts` -> 41 passed.
- `npm run test:back` -> 141 passed.
- `npm run lint` -> exit 0 with one existing `app/layout.tsx` Fast Refresh warning.
- `npx tsc --noEmit --pretty false` -> exit 0.

## Deferred To Wave 7

- `approvalProof` input schema.
- `OnchainActionApprovalProof` validation.
- `verifyActionApproval` call in the execute handler.
- Real `VersionedTransaction` signing/submission.
- Frontend Dynamic wallet signer-ready handoff if needed.
