# Wave 7 — MCP compatibility and approved execution hardening technical spec

Wave 7a hardens the `execute_approved_action` path introduced in Wave 6. It upgrades the handler from candidate-ID boundary metadata to proof-verified, unsigned-transaction execution for devnet local demos. Wave 7b will handle upstream MCP compatibility after this execution path is safe.

## Architecture

```txt
MCP client
  -> execute_approved_action(candidateId, approvalProof, transactionPayload, network)
    -> parse typed input
      -> bind approvalProof.action_hash to transactionPayload.actionHash
        -> verifyActionApproval(approvalProof)
          -> validate unsigned VersionedTransaction payload
          -> createSignerAdapter(devnet-only config)
            -> consume ApprovalIdempotencyStore(candidateId)
              -> signer.signAndSendTransaction(tx)
                -> ALLOW with real tx signature + redacted audit
```

Failure before signer availability is retryable and must not consume idempotency. Failure after the execution boundary is reached must preserve duplicate-execution protection.

## Files

| File | Role |
| --- | --- |
| `back/services/mcp/mcpToolContracts.ts` | Add `ExecuteApprovedActionInput`, approval proof payload shape, and transaction payload contract. |
| `back/services/mcp/mcpToolRegistry.ts` | Update `execute_approved_action` schema to require proof and transaction payload. |
| `back/services/mcp/mcpToolCallRouter.ts` | Parse input, verify approval, validate payload, order idempotency, call signer, and audit outcomes. |
| `back/services/signerAdapterContracts.ts` | Extend signer result types if needed while keeping contracts separate. |
| `back/services/signerAdapter.ts` | Replace mock `signAndSendTransaction` with real devnet submission. |
| `back/services/onchainApproval.ts` | Existing source of `OnchainActionApprovalProof` and `verifyActionApproval`; do not duplicate its proof contract unless extracting to a dedicated contracts file. |
| `back/services/__tests__/mcpToolCallRouter.test.ts` | Router behavior and ordering tests. |
| `back/services/__tests__/signerAdapter.test.ts` | Real signing/submission adapter tests with mocked connection boundary. |

## Input Contract

`execute_approved_action` input adds proof and transaction payload to the Wave 6 schema:

```ts
type ExecuteApprovedActionInput = {
  candidateId: string;
  network?: "devnet" | "testnet" | "mainnet-beta";
  approvalProof: OnchainActionApprovalProof;
  transactionPayload: {
    encoding: "base64";
    actionHash: string;
    unsignedVersionedTransaction: string;
  };
};
```

The router must reject empty `candidateId`, missing `approvalProof`, missing payload, unsupported encoding, and invalid transaction bytes with `REQUIRE_ADDITIONAL_CONTEXT` unless the failure is a policy/proof denial.

The router must also require a complete proof binding before signer lookup: `approvalProof.action_hash`, `approvalProof.user`, and `transactionPayload.actionHash` are mandatory for execution. If the proof action hash and payload action hash differ, Compass must return `DENY` without calling `verifyActionApproval`, consuming idempotency, or resolving the signer.

## Execution Ordering

Wave 6 consumed idempotency before signer lookup. Wave 7a changes the order:

1. Parse input.
2. Bind `approvalProof.action_hash` to `transactionPayload.actionHash`.
3. Verify `OnchainActionApprovalProof` with `verifyActionApproval`.
4. Deserialize and validate the unsigned transaction payload.
5. Resolve the signer adapter.
6. Consume `candidateId` idempotency.
7. Sign and submit.
8. Audit redacted outcome.

This preserves retryability for proof/input/config failures while still blocking duplicate submission attempts.

## Signer Adapter

`LocalKeypairAdapter.signAndSendTransaction` must stop returning `mock-signature`. For devnet demo mode it should submit the signed `VersionedTransaction` to the configured Solana RPC and return the real transaction signature.

Mainnet remains blocked by `createSignerAdapter`. If RPC or secret-key config is missing, the router returns `DENY` with `LOCAL_SIGNER_NOT_CONFIGURED` and does not consume idempotency.

## Audit Rules

Audit metadata may include:

- `candidateId`
- `approvalVerified`
- `duplicateBlocked`
- `signerPath`
- `transactionSubmitted`
- `signature` only after successful submission

Audit metadata must not include private keys, raw transaction bytes, full prompts, or unredacted secret material.

## Wave 7b Boundary

Upstream MCP compatibility should be a follow-up slice after Wave 7a. It may add allowlisted mirrored read/preparation tools, but unknown upstream tools and raw signer tools remain fail-closed.

## Verification

- `npm run test:back -- back/services/__tests__/mcpToolCallRouter.test.ts back/services/__tests__/signerAdapter.test.ts`
- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`
