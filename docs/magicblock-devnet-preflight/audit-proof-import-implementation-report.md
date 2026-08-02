# Finalized Audit Proof Import Implementation Report

Date: 2026-08-01

## Outcome

Implemented the smallest explicit, authenticated, default-off import path for
an already-finalized MagicBlock/Solana devnet audit proof at
`POST /api/magicblock-devnet/audit/import`. The path has no signer-secret,
transaction preparation, registration, or submission capability.

The server validates a closed and bounded versioned contract, rematerializes
canonical details, commitment digest, and Memo before IO, pins the signer from
`COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY`, and queries only
`getSignatureStatuses` and `getTransaction`. Literal Solana devnet RPC and
Magic Router must agree on finalized successful signature, signer, slot, Memo,
and digest evidence before persistence.

The PostgreSQL store applies idempotent compatibility ALTERs for legacy valid
tables that predate `observation_id` and `prepared_transaction`, then enforces
audit ID, observation ID, and signature uniqueness. No standalone operator
migration is required. Exact replay returns the durable original, all identity
conflicts reject, a lost write acknowledgement is safe to retry, and success
reloads all three bindings.

GET now has a separate read-only ingress, environment composition, finalized
verifier, bounded transports, canonical materializer, and confirmed-proof
PostgreSQL store. The dependency gate proves that neither GET nor import can
transitively reach the mixed signer/submitter module, full historical ingress/
store, signer secrets, signing, `register`, or `sendTransaction`. The existing
POST/register composition and behavior remain unchanged.

Pinned endpoint reads have per-request deadlines spanning stalled headers and
streamed bodies, non-blocking best-effort cancellation even when underlying
stream cancellation never settles, declared and observed byte ceilings,
redirect rejection, and bounded UTF-8/JSON parsing without `response.json()`.
Authenticated imports
require JSON media type and cancel drip/stalled request streams at their fixed
application deadline before any RPC or SQL. The same absolute-deadline property
is adversarially covered for authenticated request bodies.

## Verification

- Focused proof/import/on-chain/route tests: 5 files, 45 tests passed.
- MagicBlock preflight: 12 files, 256 tests passed.
- Full backend suite: 64 files passed / 2 skipped; 787 tests passed / 22 skipped.
- Lint, Next production build, and MCP build passed.
- JSON validation, verifier-script syntax, unchanged lockfile digest, and
  `git diff --check` passed.
- Typecheck reaches only the pre-existing unrelated missing test import
  `back/services/__tests__/mcpProxyDispatcher.test.ts` ->
  `../mcp/mcpProxyContracts`.

An intermediate concurrent run produced the existing observer E2E timing race:
its asynchronous delivery had not completed before the assertion. That file
passed immediately in isolation, the unchanged preflight rerun passed 256
tests, and the final unchanged full-suite rerun passed 787 tests; no unrelated
timeout or test expectation was relaxed.

No live RPC, secret read, transaction submission, production database write,
deployment, or flag enablement occurred.
