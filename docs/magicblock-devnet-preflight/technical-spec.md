# MagicBlock Devnet On-Chain Audit Technical Spec

## Architecture

```text
eligible MCP result
  -> authenticated hosted audit ingress
  -> trusted v0 transaction decode
  -> bounded Magic Router getDelegationStatus evidence
  -> canonical Postgres audit event + SHA-256 ledger link
  -> canonical private commitment details
  -> signed Solana Memo transaction via Magic Router devnet
  -> independent confirmation and transaction read via Solana devnet RPC
  -> completed observation + retrievable confirmed proof
```

The implementation uses the official Magic Router devnet endpoint
`https://devnet-router.magicblock.app/` for `getBlockhashForAccounts` and
`sendTransaction`. Verification normally uses only the compile-time literal
`https://api.devnet.solana.com/`. Redirects, alternate clusters, and endpoint
configuration are rejected.

References:

- Magic Router: <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router>
- `getBlockhashForAccounts`:
  <https://docs.magicblock.gg/api-reference/er-api/getBlockhashForAccounts>
- Current equivalent:
  <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getBlockhashForAccounts>
- Solana Memo transaction: <https://solana.com/developers/cookbook/transactions/add-memo>
- Solana `getTransaction`: <https://solana.com/docs/rpc/http/gettransaction>

## Contracts

Shared on-chain contracts live in
`back/services/magicBlockOnchainAuditContracts.ts`; signing, submission, and
verification behavior lives separately in
`back/services/magicBlockOnchainAudit.ts`. Closed Router diagnostic types also
live in the contracts file; sanitization, exact-shape validation, and
preflight classification live in `back/services/magicBlockRouterDiagnostics.ts`.

The canonical private schema is
`compass.magicblock-audit-commitment/v1`. Its digest is:

```text
SHA-256(
  UTF8("compass.magicblock-audit-commitment/v1\0")
  || UTF8(canonicalJson(privateCommitmentDetails))
)
```

The on-chain Memo is `compass:audit:v1:` followed by compact canonical JSON:
`{a,c,l,o,p,v}` for audit ID, commitment digest, current ledger digest,
outcome, previous ledger digest, and version. Canonical private details bind
the observation, transaction, request, final result, attestation, ledger chain,
cluster, and outcome without disclosing those raw payloads.

The finalized import contract is isolated in
`back/services/magicBlockAuditProofImportContracts.ts`. The hosted handler and
environment composition live in
`hosted/magicblock/magicBlockAuditProofImportIngress.ts` and
`hosted/magicblock/magicBlockAuditProofImportIngressFromEnv.ts`; the latter
imports no submitter and reads no signer-secret variable. Shared constant-time
Bearer comparison is implemented in `magicBlockIngressAuth.ts` with its type
in a dedicated contracts file.

Read-only proof contracts, canonical materialization, and behavior live in
`magicBlockAuditProofVerificationContracts.ts`,
`magicBlockAuditCommitment.ts`, and
`magicBlockAuditProofVerification.ts`. Import and GET use the dedicated
`magicBlockAuditProofRecordStorePg.ts`; GET has its own
`magicBlockAuditReadIngress{,FromEnv}.ts` composition. Their transitive closure
cannot reach the mixed signer/submitter module, historical full ingress/store,
`fs`, signer-secret loading, Keypair/signing, `register`, or
`sendTransaction`; the dependency gate enforces this structurally and by
forbidden capability scan. The full historical POST/register composition is
unchanged.

The proof verifier is read-only and bounded to one
`getSignatureStatuses` plus one `getTransaction` per endpoint. Both literal
endpoints must independently report `finalized`, the same successful slot,
transaction signature, configured required signer, exact Memo, and commitment
digest. Only then is a confirmed record saved and reloaded by audit ID,
observation ID, and signature. Store initialization applies the historical,
idempotent `ADD COLUMN IF NOT EXISTS observation_id`, partial unique
observation index, and `ADD COLUMN IF NOT EXISTS prepared_transaction`
compatibility changes before use. This supports valid legacy tables without a
separate operator-run migration while preserving all three identity guards.

Both clients pin their exact compile-time HTTPS URL, use `redirect: error`,
apply a fail-closed deadline spanning fetch headers and streaming body reads,
initiate cancellation without awaiting a potentially non-settling transport,
validate `Content-Length`, enforce a byte ceiling while reading chunks, decode
UTF-8 and parse JSON only after the bounded read, and expose no raw response or
transport error. Import request reading independently has a fixed five-second
application deadline and 8 KiB ceiling; its cleanup likewise never extends the
deadline while best-effort cancellation remains rejection-safe.
`application/json` is mandatory; standard parameters such as UTF-8 charset are
accepted.

## Persistence

`magicblock_devnet_audit_ledger` remains the exact private event source and
hash chain. Ledger append no longer marks an observation completed.

`magicblock_devnet_onchain_audit` stores:

- observation and audit IDs;
- canonical private details;
- commitment digest and exact Memo;
- registration status, code, signature, signer, slot, verification time, and
  optional sanitized Router diagnostics.
- nullable private `prepared_transaction`: the strict complete prepared
  transaction contract, including signed base64, SHA-256, and dual blockhash
  validity evidence. Existing rows without it remain readable and may only
  reconcile their already-reserved signature; missing legacy material cannot
  authorize a new send.

Uniqueness constraints prevent one observation, audit ID, or signature from
being bound to multiple records. Confirmed state is monotonic. The complete
prepared object is stored in the claim-fenced reservation before
`sendTransaction`, so a response loss is reconciled by verification rather
than duplicate submission. Conflict replay returns the original object; exact
mismatch blocks the submitter callback. Retryable and confirmed saves preserve
the original private column and reject attempted replacement.

`magicblock_devnet_observations` transitions to completed only with a confirmed
registration. The cached completed result is therefore safe to return as
idempotent success.

## Signing and verification

The audit signer is loaded from exactly one of:

- `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY`: base58 secret key or
  JSON array containing the 64 key bytes.
- `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE`: absolute path to a
  file containing either format.

`COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY` pins the expected public
key. The loader can parse a signer without this optional configuration value
for deterministic/local use, but the pin is mandatory for every authorized
smoke and Production operation. Invalid, oversized, unreadable, relative-path,
or mismatched inputs disable the signer. Secrets are never logged or returned.

Submission first builds the final unsigned legacy Solana transaction with the
dedicated Compass-controlled audit authority as fee payer and required Memo
signer. That fee-payer identity is invariant: no user, treasury, demo, mainnet,
or fallback key may replace it. It derives a deduplicated routing list with the
fee payer first and every writable instruction account after it, then calls the
raw official API shape:

```json
{
  "method": "getBlockhashForAccounts",
  "params": [["<fee-payer>", "<writable-account>", "..."]]
}
```

The result must directly contain a canonical `blockhash` and non-negative
integer `lastValidBlockHeight`. Only then is the blockhash assigned and the
transaction deterministically signed. Magic Router performs preflight and
submission. Independent verification calls `getSignatureStatuses` and `getTransaction`,
decodes the compiled Memo instruction, validates the Memo program ID and signer
index, then compares the exact expected Memo and commitment digest.

Before `onPrepared`, the submitter asks both literal Solana devnet and Magic
Router `isBlockhashValid` at `confirmed`. Each closed observation binds
endpoint, blockhash, commitment, context slot, validity, and canonical
timestamp. Both must explicitly return valid; disagreement, malformed data, or
unavailability returns `BLOCKHASH_VALIDITY_UNCONFIRMED`. Hosted persistence
retains only the sanitized code, commitment/Memo binding, selected blockhash,
and last-valid height: it retains no signature or `prepared_transaction`, and
no send is reachable. After the observation claim lease expires, an eligible
retry therefore runs `register` again with a fresh Router-selected blockhash.
This retry applies only to the devnet audit-Memo lane and releases no payment or
generic execution fence.

Required `onPrepared` receives one closed self-contained object: deterministic
signer/signature, commitment, Memo, blockhash/last-valid height, exact canonical
signed transaction base64, plain SHA-256 of those bytes, the two validity
observations, devnet audit-Memo lane, and `valueTransferLamports=0`. The
submitter compares the returned object byte-for-byte/canonically and sends the
exact base64 it originally handed to the callback. Callback omission,
alteration, or failure makes `sendTransaction` unreachable. Hosted retries find
the reserved signature and verify it; they do not sign or submit a replacement.

Read-only reconciliation can be constructed with an expected public signer and
an RPC transport; it does not require a signer secret. An explicit non-null
signature-status `err` or transaction `meta.err` maps to
`TRANSACTION_EXECUTION_FAILED` only when confirmed/finalized status failure is
corroborated by non-null `getTransaction.meta.err`. Null/malformed
`getTransaction`, processed-only failure, expected
signer mismatch, Memo/commitment mismatch, and other proof failures remain
`TRANSACTION_VERIFICATION_FAILED`.

Compass owns funding and public-balance monitoring for the dedicated authority.
The operational gate verifies the pinned public key and an operator-approved
minimum balance before authorization or Production enablement. A low balance
blocks new operation, emits an operator alert without signer secrets, and
requires replenishment of the same authority followed by balance and pin
reverification. If insufficient funds is encountered during submission, the
registration remains retryable and audited operation stays fail-closed; it
must not trigger payer/key substitution. This correction does not add an
automated balance monitor or replenishment mechanism; the connector operator
must enforce and record this gate until a separately reviewed monitor exists.

Router diagnostics are an exact allowlist of primitive fields:
`rpcMethod`, optional `httpStatus`, optional `rpcErrorCode`, optional
240-character sanitized ASCII `message`, and optional safe 128-character
`requestId`. Long tokens, URLs, sensitive detail suffixes, raw bodies, arbitrary
object keys, and non-primitive values are discarded. JSON-RPC preflight
rejections from `sendTransaction` map to `ROUTER_PREFLIGHT_REJECTED` whether
the validated Router endpoint carries them with HTTP 200 or a non-200 status;
generic transport and malformed-response failures remain
`ROUTER_UNAVAILABLE`.

## HTTP behavior

The route is absent unless `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true` and
uses a dedicated bearer. `POST` returns `200` only after confirmed on-chain
verification; retryable registration returns `503` with the stable audit
metadata. `GET ?auditId=...` or `GET ?signature=...` refreshes verification and
uses the same success rule. Both methods explicitly project
`details/canonicalDetails/registration`; neither returns
`preparedTransaction` or signed base64.

The MCP client awaits the hosted result with a 20-second default and 45-second
maximum. It accepts only a closed confirmed proof. All other outcomes are
attached to the Compass result as `retryable_failure`.

## Live devnet reconciliation and smoke

Prerequisites are a dedicated audit keypair funded with devnet SOL and the
three signer variables above. The expected public-key pin and sufficient
balance on that same Compass-controlled fee payer must be verified before
authorization. No user/mainnet/fallback key may be used. Reconcile a known
prepared signature without submitting:

```sh
COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNATURE=<known-signature> \
COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNER=<prepared-public-signer> \
  npm run smoke:magicblock-devnet-onchain -- reconcile
```

This performs read-only verification against literal Solana devnet RPC and
Magic Router. It imports an older signature into durable `legacy_pending` state
when no local manifest exists. Ambiguous reconciliation leaves that state in
place and blocks submission.

Direct-smoke state lives under the ignored local directory
`.compass-magicblock-devnet-smoke/` by default. Its closed state machine is:

```text
authorized(one-run nonce)
  -> active(no signature; send is still unreachable)
  -> pending(public signer + signature + commitment digest + public Memo
             + blockhash + last-valid height + exact signed bytes/SHA-256
             + dual valid-blockhash evidence persisted atomically)
  -> reconciled(confirmed | failed | expired_not_landed)

v1 signature-only legacy_pending -> quarantined(historicalOutcome=unknown)
quarantined -> archived history + authorized(new one-run nonce/new auditEventId)

active -> reconciled(not_submitted)
```

The authorization nonce is atomically consumed when `active` is written.
`onPrepared` atomically replaces `active` with `pending` before returning to the
submitter, and `sendTransaction` occurs only after that return. Therefore an
`active` crash is provably not submitted, while a `pending` crash must reconcile
the same signature. New authorization refuses any non-reconciled state.
Reconciled and quarantined states are archived before a new nonce is created.
The v3 manifest intentionally contains public signed transaction bytes for
self-contained recovery, but every read recomputes their SHA-256, parses the
legacy transaction, verifies its signature, and binds the fee payer, signer,
signature, blockhash, sole Memo instruction, and exact Memo. It never contains
a signer secret, and CLI output/diagnostics never include the base64.

Pending reconciliation uses the stored signer address, not the currently
configured secret or public-key pin. It closes as `failed` only when both
queried routes report the distinct explicit
`TRANSACTION_EXECUTION_FAILED`. A null/malformed transaction response, signer
rotation/mismatch, Memo/commitment mismatch, generic transport failure, or any
other `TRANSACTION_VERIFICATION_FAILED` remains ambiguous and keeps the state
pending.

After the safe gate is complete, create one authorization:

```sh
npm run smoke:magicblock-devnet-onchain -- authorize
```

Then consume the emitted nonce once:

```sh
COMPASS_MAGICBLOCK_DEVNET_AUTHORIZATION_NONCE=<nonce> \
  npm run smoke:magicblock-devnet-onchain -- submit
```

The reconciliation output contains only `mode`, durable `state`, terminal
`outcome`, the public signature when one exists, sanitized per-endpoint
status/code/slot observations, and bounded expiry evidence. The CLI does not
emit the audit ID, signer, commitment digest, signed transaction base64, or an
explorer URL. An operator may construct a devnet explorer URL separately from
the public signature. If the credential is unavailable, deterministic
injected-RPC tests are the verification evidence and live proof remains
explicitly blocked. This remediation does not claim a live rerun.

## Smoke state v3 and legacy recovery

`compass.magicblock-devnet-smoke-state/v3` makes future pending state
self-contained. One fsync + rename stores the signed transaction base64 and
SHA-256 with its complete public binding and both pre-send validity
observations before send is reachable. A restart never regenerates or resigns
those bytes. The reader strictly accepts v1/v2 shapes and normalizes their
non-self-contained pending states to blocking `legacy_pending`, retaining all
available original evidence.

The exceptional `import-legacy-evidence` mode accepts one absolute, regular,
at-most-4096-byte base64 transaction file outside the state directory.
`Transaction.from`,
the matching signer entry, exact stored base58 signature, and
`verifySignatures(false)` must all validate. The durable enrichment is
`compass.magicblock-legacy-evidence/v1`: authorization metadata, exact risk
acknowledgement, SHA-256 of serialized bytes, derived recent blockhash, and
import timestamp. Raw bytes and keys are excluded. A second import is rejected.

Reconciliation collects separately from literal devnet and Magic Router:
verified registration, finalized `isBlockhashValid`, optional finalized
`getBlockHeight`, then
`getSignatureStatuses(searchTransactionHistory=true)`. Persisted evidence binds
endpoint, signature, recent blockhash, finalized commitment, expiry/status
context slots, observation timestamp, and optional height.
`expired_not_landed` requires both
registrations to remain `SUBMISSION_UNCONFIRMED`, both explicit null signature
lookups at context slots not older than their endpoint's expiry observation,
both invalid-blockhash results, and every available height to exceed
the stored last-valid height. Only identical endpoint outcomes terminalize;
conflicts and malformed/unavailable evidence preserve state.

The exact signature-only v1 incident cannot be deterministically reconstructed:
Solana signatures cover the serialized Message, while the Message—not the
signature—contains the recent blockhash and instructions. Null
`getSignatureStatuses`/`getTransaction` results are non-terminal and
endpoint-relative. See the Solana
[transaction structure](https://solana.com/docs/core/transactions/transaction-structure),
[signature status](https://solana.com/docs/rpc/http/getsignaturestatuses), and
[transaction lookup](https://solana.com/docs/rpc/http/gettransaction)
contracts.

`quarantine-legacy` first performs read-only reconciliation. Dual confirmed or
dual execution-failed evidence reconciles normally. Otherwise, the mode
requires exact acknowledgement plus authorization ID, incident reference,
operator, reason, and authorization timestamp. Strict v3 quarantine state
preserves the complete v1 evidence and stores only bounded endpoint/status/time
observations (or a structured read-only-unavailable reason),
`historicalOutcome="unknown"`, and the fixed terminalization-impossible reason.
It prohibits retry of the old signature, sets `valueTransferLamports=0`, and
keeps `genericExecutionFenceReleased=false`. A matching replay is idempotent;
metadata changes conflict. Authorize archives the quarantine before issuing a
new one-run nonce, so the old record remains in history and the new run creates
a new `auditEventId`.

This is lane-specific administrative containment, not terminalization. Its
residual exposure is at most one new devnet audit Memo and its possible fee;
it cannot execute a user payment. Solana fee documentation is not proof that a
historical transaction did or did not execute, and failed transactions may
charge fees; see the [transaction pipeline](https://solana.com/docs/core/transactions/transaction-pipeline).

```text
v1/v2 pending -> v3 legacy_pending(blocking, original evidence retained)
legacy_pending -> legacy_pending(+ verified evidence digest/blockhash)
v3 pending | enriched legacy_pending
  -> reconciled(confirmed | failed | expired_not_landed)
exact v1 signature-only legacy_pending
  -> quarantined(unknown; old signature prohibited; devnet Memo lane only)
  -> archived + authorized(new one-run audit)
active -> reconciled(not_submitted)
```
