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

## Persistence

`magicblock_devnet_audit_ledger` remains the exact private event source and
hash chain. Ledger append no longer marks an observation completed.

`magicblock_devnet_onchain_audit` stores:

- observation and audit IDs;
- canonical private details;
- commitment digest and exact Memo;
- registration status, code, signature, signer, slot, verification time, and
  optional sanitized Router diagnostics.

Uniqueness constraints prevent one observation, audit ID, or signature from
being bound to multiple records. Confirmed state is monotonic. The prepared
signed signature is stored before `sendTransaction`, so a response loss is
reconciled by verification rather than duplicate submission.

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

`onPrepared` receives the deterministic signature, commitment, and Memo before
`sendTransaction`. A different persisted signature stops submission. Hosted
retries find the reserved signature and verify it; they do not sign or submit a
replacement.

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
uses the same success rule.

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
             + blockhash + last-valid height persisted atomically)
  -> reconciled(confirmed | failed | expired_not_landed)

active -> reconciled(not_submitted)
```

The authorization nonce is atomically consumed when `active` is written.
`onPrepared` atomically replaces `active` with `pending` before returning to the
submitter, and `sendTransaction` occurs only after that return. Therefore an
`active` crash is provably not submitted, while a `pending` crash must reconcile
the same signature. New authorization refuses any non-reconciled state.
Reconciled states are archived before a new nonce is created. The manifest
never contains a signer secret or serialized transaction.

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

Successful output contains only the public audit ID, signer, signature, slot,
commitment digest, and
`https://explorer.solana.com/tx/<signature>?cluster=devnet`. If the credential
is unavailable, deterministic injected-RPC tests are the verification evidence
and live proof remains explicitly blocked. This remediation does not claim a
live rerun.

## Smoke state v2 and legacy recovery

`compass.magicblock-devnet-smoke-state/v2` adds
`recentBlockhash` and `lastValidBlockHeight` to `pending`. The submitter passes
those values through the existing `onPrepared` callback and rejects altered
callback evidence, so the exact signed transaction context is fsynced before
send. The reader strictly accepts historical v1 shapes and normalizes v1
`pending`/`legacy_pending` to v2 `legacy_pending`, retaining original evidence.

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

```text
v1 pending -> v2 legacy_pending(blocking, original evidence retained)
legacy_pending -> legacy_pending(+ verified evidence digest/blockhash)
pending | enriched legacy_pending
  -> reconciled(confirmed | failed | expired_not_landed)
active -> reconciled(not_submitted)
```
