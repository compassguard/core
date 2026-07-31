# MagicBlock On-Chain Audit Correction Report

## 2026-07-29 Magic Router incident remediation

The live smoke incident found that the audit transaction used root
`getLatestBlockhash`, even though Magic Router routes by the transaction's
accounts. For the undelegated audit payer this could pair an ER blockhash with a
base-layer submission. The adapter also collapsed all Router errors to
`ROUTER_UNAVAILABLE`.

The local correction now:

1. constructs the final legacy Memo transaction before signing;
2. derives fee payer plus every writable instruction account, deduplicated in
   deterministic order;
3. calls raw official `getBlockhashForAccounts` with `params: [[...accounts]]`;
4. signs only after validating the returned blockhash and
   `lastValidBlockHeight`;
5. retains `onPrepared` before `sendTransaction` and hosted
   verify-existing-signature reconciliation;
6. reports upstream preflight as `ROUTER_PREFLIGHT_REJECTED` with only bounded,
   sanitized, allowlisted primitive diagnostics;
7. persists and returns those closed diagnostics in the hosted retryable
   registration without copying raw response keys; and
8. uses a durable local smoke state with a one-run authorization nonce,
   atomic prepared-signature persistence, refusal while active/pending, and
   non-submitting reconciliation before reauthorization; and
9. persists the prepared public signer for secret-free reconciliation, with
   `TRANSACTION_EXECUTION_FAILED` separated from proof ambiguity so only dual
   explicit execution failure can reopen authorization.

Official references:

- <https://docs.magicblock.gg/api-reference/er-api/getBlockhashForAccounts>
- <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getBlockhashForAccounts>
- <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router>

This work performed no deployment, ingress/MCP enablement, or live
transaction-producing smoke. Live rerun remains blocked by the documented safe
operational gate.

Final post-fix verification passed the dependency closure and MagicBlock
preflight at 9 files / 213 tests; the unified backend suite outside the sandbox
at 61 files passed / 2 skipped and 744 tests passed / 22 skipped; lint; Next
application build; MCP build; and `git diff --check`. The initial sandbox
`listen EPERM` was environmental and the unified outside-sandbox run passed.
TypeScript no-emit reaches only the pre-existing unrelated missing test import
from `mcpProxyDispatcher.test.ts` to `../mcp/mcpProxyContracts`, proven present
at the branch base. The read-only source incident SHA-256 remains
`6a3cb83688e69dca01f4e8f30c27858703f512c3a14d82bfc9a152ea5fc30294`.

Independent read-only review and re-reviews found no remaining critical, high,
or medium issue. The low stale-count finding was corrected to the current 35
focused tests.

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
3. signs a compact privacy-safe Memo transaction with the dedicated
   Compass-controlled devnet audit authority as both fee payer and required
   Memo signer, then submits it through Magic Router devnet;
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

The prior correction had no funded credential in its worker environment. The
subsequent incident documented a dedicated signer, 6 devnet SOL at attempt
time, and a prepared signature. This remediation did not recheck current
balance/configuration and intentionally performed no live RPC or submission.
No new signature or explorer evidence is claimed here.

Required configuration:

```text
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY=<base58 or 64-byte JSON array>
# or:
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE=<absolute key-file path>
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY=<expected devnet public key>
```

The public key pin must resolve to the dedicated Compass-controlled authority,
which MUST remain the fee payer. Compass owns its funding and public-balance
monitoring. Before authorization, an operator must verify the pin and an
approved minimum balance sufficient for the planned operation and reserve. Low
balance blocks authorization and new audited operation: alert without exposing
secret material, replenish only this authority, then recheck balance and pin.
Never substitute a user, treasury, demo, mainnet, or fallback payer/key.

First reconcile the known signature without submitting:

```sh
COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNATURE=<known-signature> \
COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNER=<prepared-public-signer> \
  npm run smoke:magicblock-devnet-onchain -- reconcile
```

An ambiguous result durably remains `legacy_pending` and blocks authorization.
Only after terminal reconciliation and the remaining safe gate may an operator
create a single-use authorization:

```sh
npm run smoke:magicblock-devnet-onchain -- authorize
```

Use the emitted nonce exactly once:

```sh
COMPASS_MAGICBLOCK_DEVNET_AUTHORIZATION_NONCE=<nonce> \
  npm run smoke:magicblock-devnet-onchain -- submit
```

Expected public-only output includes the audit ID, signer, signature, slot,
commitment digest, and:

```text
https://explorer.solana.com/tx/<signature>?cluster=devnet
```

## Remaining risks

- A prepared transaction that never lands remains bound to its stable signature
  until the implemented dual-endpoint expired-and-not-landed recovery proves
  safe replacement. Legacy records without cryptographically recoverable
  blockhash evidence remain blocked.
- Production operation requires Compass-owned devnet signer funding, rotation,
  public-balance monitoring, alerting, and public-key pin verification.
  This correction adds neither an automated balance monitor nor replenishment;
  low-balance handling remains a connector-operator gate and no automatic
  fallback payer exists. Mainnet remains unsupported and disabled.
- A new live devnet proof remains blocked on reconciliation, complete local
  operator/configuration rechecks, the reviewed two-stage merge/deploy, and
  explicit one-transaction authorization. No live action is claimed here.

## Delivery

The corrected cumulative parent branch starts from PR #19 head
`9aaa5f5272ae843a764645c201526b532648d1f7`. The open parent
[PR #20](https://github.com/compassguard/core/pull/20) has head
`ram4-dev/magicblock-onchain-audit-review`, targets
`release/compass_migration`, and is intended to supersede the contradictory
three-PR stack. At the time of the final read-only GitHub verification, this
incident-remediation feature branch had no PR.

Delivery therefore requires two reviewed merges in order: first a new stacked
incident-remediation PR into `ram4-dev/magicblock-onchain-audit-review`, then
the updated parent PR #20 into `release/compass_migration`. Neither targets
`main`. Production deployment must use the reviewed resulting release merge
commit, or an exact commit explicitly instructed after both merges, never an
unmerged feature head. The earlier parent implementation commit is
`6c42222f69c4acf5e3c343a00fbea95064698e01`.

The user authorizes a Vercel Production deployment only after the correction
has been independently reviewed, the final verification is green, and the
two-stage stack above is merged. This documentation pass performs no merge,
deployment, configuration mutation, live RPC call, or live smoke.

## 2026-07-30 legacy pending exact-once recovery

Implemented smoke-state schema v2 and strict v1 normalization. New preparation
persists signature, signer, commitment/Memo, recent blockhash, and
last-valid height atomically before send. Reconciliation now requires matching
dual-endpoint terminal evidence and supports `expired_not_landed` only with
independent no-signature plus expired-blockhash proof.

Implemented one exceptional enrichment operation for v1 legacy records. It
requires bounded signed transaction evidence, cryptographic stored
signer/signature verification, explicit authorization metadata and exact risk
acknowledgement. It persists only SHA-256, derived blockhash, original public
evidence, and sanitized metadata. It cannot close, reset, authorize, or submit.

Regression coverage includes the exact historical v1 pending shape, safe
migration/enrichment, evidence replay refusal, dual disagreement, missing
expiry evidence, expired proof, terminal replay/idempotency, prepared
blockhash/height persistence, and bounded expiry diagnostics. No network or
external side effect was used.

Independent review remediation makes expiry evidence a coherent post-expiry
observation: finalized invalidity is established first, signature history is
re-read at an equal-or-later context, and endpoint/signature/blockhash/slots/
timestamp are durably bound. Processed fork errors no longer terminalize;
confirmed/finalized failure requires `getTransaction.meta.err`
corroboration. The submit mode now invokes dual reconciliation instead of
closing from its single Solana verification.
