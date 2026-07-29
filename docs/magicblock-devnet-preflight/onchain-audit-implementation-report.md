# MagicBlock On-Chain Audit Correction Report

## Root cause

PRs [#16](https://github.com/compassguard/core/pull/16),
[#18](https://github.com/compassguard/core/pull/18), and
[#19](https://github.com/compassguard/core/pull/19) split the MagicBlock work
into a preflight read, a private Postgres ledger, and a fail-open MCP observer.
Their contracts and documentation explicitly excluded signing, Solana
submission, registry writes, and checkpoints. That stack therefore recorded
neither a durable public commitment nor a verifiable final Compass audit state.
PR #14 is unrelated analytics work and was not touched.

## Corrected architecture

For every eligible transaction observation, Compass now:

1. derives and persists the canonical private audit event and SHA-256 ledger
   link;
2. materializes private commitment details binding the stable observation,
   transaction, request, result, attestation, ledger chain, and outcome;
3. signs a compact privacy-safe Memo transaction with a dedicated devnet audit
   authority and submits it through Magic Router devnet;
4. verifies confirmation, transaction success, required signer, Memo program,
   exact Memo, and commitment digest through independent Solana devnet RPC;
5. completes the observation and reports success only after that verification;
6. reuses the prepared signature for idempotent recovery and exposes retryable
   failures instead of fail-open success;
7. supports authenticated lookup and re-verification by audit ID or signature.

The Memo contains only the stable audit ID, aggregate commitment, previous and
current ledger digests, outcome, and schema version. Raw transactions, requests,
results, provider payloads, credentials, and secrets remain off-chain.

## Implementation

Primary additions and changes:

- `back/services/magicBlockOnchainAuditContracts.ts`
- `back/services/magicBlockOnchainAudit.ts`
- `hosted/magicblock/magicBlockAuditRecordStorePg.ts`
- `hosted/magicblock/magicBlockAuditIngress.ts`
- `hosted/magicblock/magicBlockAuditLedgerPg.ts`
- `hosted/magicblock/magicBlockObservationStorePg.ts`
- `back/services/mcp/observer/magicBlockHostedAuditClient.ts`
- `back/services/mcp/server/mcpServer.ts`
- `scripts/smoke-magicblock-devnet-onchain.ts`
- focused unit, Postgres, route, observer, dependency-closure, and E2E tests
- corrected functional, technical, rollout, environment, and README guidance

## Verification

- `npm run preflight:magicblock-devnet`
- `npm test`
- `npm run lint`
- `npm run build`
- `npm run build:mcp`
- `node --check scripts/verify-magicblock-preflight-dependency-closure.mjs`
- `npx tsc --noEmit --pretty false` reaches one pre-existing unrelated missing
  test-only import:
  `back/services/__tests__/mcpProxyDispatcher.test.ts` imports
  `../mcp/mcpProxyContracts`.

The deterministic E2E covers MCP request, Compass result, Postgres canonical
ledger, on-chain submission seam, record persistence, lookup by audit ID and
signature, and independent verification.

Two fresh read-only reviews identified and drove fixes for prepared-signature
GET reconciliation, stale-claim send races, response-body deadline/bounds,
strict persisted proof binding, ambiguous dual signer configuration, and
retention of prepared context across transient verification failures. Focused
Postgres regressions cover the resulting reservation and retry transitions.

## Live devnet proof blocker

No dedicated funded devnet audit signer was available in this worker
environment. No synthetic signature or claimed explorer evidence was produced.

Required configuration:

```text
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY=<base58 or 64-byte JSON array>
# or:
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE=<absolute key-file path>
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY=<expected devnet public key>
```

The public key must hold enough devnet SOL to pay for one Memo transaction.
Then run:

```sh
npm run smoke:magicblock-devnet-onchain
```

Expected public-only output includes the audit ID, signer, signature, slot,
commitment digest, and:

```text
https://explorer.solana.com/tx/<signature>?cluster=devnet
```

## Remaining risks

- A prepared transaction that never lands remains bound to its stable signature
  and explicit retryable state; an operator recovery policy for replacing a
  permanently expired transaction is still needed.
- Production operation requires devnet signer funding, rotation, monitoring,
  and alerting. Mainnet remains unsupported and disabled.
- Live devnet transport proof remains blocked solely on the dedicated funded
  credential above.

## Delivery

The corrected cumulative branch starts from PR #19 head
`9aaa5f5272ae843a764645c201526b532648d1f7`. Replacement
[PR #20](https://github.com/compassguard/core/pull/20) targets
`release/compass_migration` and supersedes the contradictory three-PR stack.
The implementation commit is
`6c42222f69c4acf5e3c343a00fbea95064698e01`; the PR head also includes this
report update.
