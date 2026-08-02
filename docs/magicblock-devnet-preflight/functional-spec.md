# MagicBlock Devnet On-Chain Audit Functional Spec

## Outcome

Every eligible Compass transaction observation must end in exactly one of these
externally visible audit states:

- `confirmed`: Compass has persisted the canonical private audit and verified
  the matching Solana transaction at `confirmed` or `finalized` commitment.
- `retryable_failure`: Compass has not proved the on-chain record yet. This
  state must never be represented as audit success.

The feature is disabled by default and supports devnet only. Mainnet endpoints,
mainnet keys, and user wallet keys are not accepted by this integration.

## Eligible transaction

An eligible transaction is an allowed, non-error MCP result whose root
`structuredContent` exactly matches
`compass.magicblock-devnet-observation/v1`. Compass decodes the unsigned v0
transaction, derives its account bindings, obtains bounded MagicBlock devnet
evidence, and writes the canonical audit event to its append-only Postgres
ledger.

The MCP result retains its normal content and additionally receives
`structuredContent.compassAudit`. Missing configuration, timeout, transport
failure, an unconfirmed signature, or failed verification produces an explicit
retryable state there; the observer is not fail-open.

## Durable audit and public commitment

The private ledger preserves the exact closed audit payload and its
domain-separated SHA-256 hash-chain values. The on-chain record is a signed
standard Solana Memo transaction submitted through the official Magic Router
devnet endpoint. Its compact closed payload contains:

- schema version;
- stable `auditEventId`;
- aggregate commitment digest over the canonical private details;
- previous and current private-ledger digests;
- final Compass outcome.

The canonical private commitment details bind the observation ID, audit event
ID, transaction digest, request digest, result digest, attestation digest,
previous/current ledger digests, cluster, and outcome. Raw transactions, raw
requests, raw results, API keys, signer material, wallet secrets, and provider
payloads are never published in the Memo.

The signing key is a dedicated, Compass-controlled, funded devnet audit
authority. It may be loaded from one explicit environment value or an absolute
key-file path. That authority MUST remain both the transaction fee payer and
the required Memo signer. No user wallet is asked to sign an audit record, and
the flow must never substitute a user, treasury, demo, mainnet, or fallback
payer/key.

Compass owns signer funding and public-balance monitoring. The expected public
key must be pinned and verified before an authorized smoke or production
operation. If its balance is below the operator-approved minimum for the
planned operation and reserve, the flow is fail-closed: do not authorize or
enable new audited operations, alert the Compass operator, replenish only that
dedicated authority, and recheck its balance and pin before continuing. No
balance check, alert, or replenishment may expose signer secret material.

Before signing, Compass constructs the final legacy transaction and asks Magic
Router `getBlockhashForAccounts` for a route-aware blockhash using one
deduplicated account list: fee payer first, followed by every writable
instruction account. An undelegated fee payer therefore selects the Solana base
layer rather than an unrelated ER blockhash. Root `getLatestBlockhash` is not a
valid preparation source for this flow.

## Confirmation, retry, and idempotency

Compass persists the deterministically signed transaction signature and
commitment before sending it. A retry for the same audit verifies that same
signature instead of creating a second record. Observation completion occurs
only after independent Solana devnet RPC verification proves:

- the signature is confirmed or finalized and the transaction succeeded;
- the transaction contains the expected Memo program instruction;
- the configured audit authority is a required signer of that instruction;
- the exact Memo and aggregate commitment digest match the private record.

A signed but unconfirmed transaction remains queryable as
`retryable_failure`; it is not a completed observation.

Retryable Router failures may include only closed, bounded diagnostic fields:
RPC method, HTTP status, JSON-RPC error code, sanitized message, and safe
request/correlation ID. A Router `sendTransaction` preflight rejection is
reported as `ROUTER_PREFLIGHT_REJECTED`, distinct from generic
`ROUTER_UNAVAILABLE`. Serialized transactions, request bodies, Memo/private
audit details, secrets, arbitrary response keys, and unvalidated URLs are never
copied into diagnostics.

`TRANSACTION_EXECUTION_FAILED` is reserved for a confirmed/finalized non-null
`status.err` corroborated by a fetched transaction with non-null `meta.err`.
Processed/fork-only errors and missing/malformed transaction proof,
unexpected signer, Memo/commitment mismatch, or other proof ambiguity remains
`TRANSACTION_VERIFICATION_FAILED` and must not authorize replacement.

## Query and verification

The separately authenticated audit route accepts `GET` with exactly one of
`auditId` or `signature`. It loads the durable record, rematerializes the
expected commitment, reads the transaction from literal Solana devnet RPC, and
Magic Router through the isolated finalized proof verifier, and returns `200`
only when both endpoints agree on the exact finalized proof. Missing, malformed,
unconfirmed, mismatched, or failed transactions do not verify.

## Finalized proof import

The separate `/api/magicblock-devnet/audit/import` POST accepts only the closed
`compass.magicblock-audit-proof-import/v1` contract while the existing ingress
flag is enabled and the dedicated ingress bearer authenticates. It imports an
already-finalized devnet proof; it never signs, prepares, registers, submits,
or retries a Solana transaction. The caller cannot choose the signer.

Before RPC or SQL, Compass validates exact request shape and bounds, devnet
cluster, identifiers, digests, signature, canonical details, and the exact
server-rematerialized commitment digest and Memo. It then requires finalized,
successful, coherent, exact signer/Memo/digest/signature/slot evidence from
both literal Solana devnet RPC and Magic Router. Any unavailable, malformed,
redirected, unconfirmed, failed, mismatched, or disagreeing evidence persists
nothing. Exact durable replay returns the original record; conflicts by audit
ID, observation ID, or signature return an idempotency conflict. A lost write
acknowledgement is safe: retry reloads all three durable identities before
returning success.

Authenticated import requires JSON media type before body parsing or any RPC/
SQL work. One fixed application deadline covers the bounded streaming request
body and initiates rejection-safe cancellation without awaiting a potentially
non-settling reader. Each pinned endpoint request separately bounds headers and
streaming response reads with the same absolute-deadline cleanup, validates
declared and observed byte length, rejects redirects and malformed JSON, and
returns only sanitized closed failure fields.

## Acceptance

- Every eligible result exposes either confirmed proof or explicit retryable
  failure.
- Postgres retains the canonical private details and one record per observation,
  audit ID, and signature. Before production submission it also atomically
  retains the exact self-contained prepared transaction and validity evidence;
  later retryable/confirmed updates cannot overwrite or remove that material.
- The Solana Memo exposes no sensitive raw payload.
- A no-live-service E2E proves request -> Compass result -> canonical ledger ->
  signed Magic Router submission -> independent retrieval and verification.
- Live devnet proof is recorded only when a dedicated funded credential is
  available; tests never synthesize a claimed live signature.
- The direct smoke reconciles a supplied known signature without submitting and
  requires a durable, atomically consumed one-run nonce before creating one new
  transaction.
- Before send, its required `onPrepared` callback atomically persists the exact
  canonical signed transaction bytes and their plain SHA-256 digest together
  with the public signer, signature, commitment, Memo, blockhash/last-valid
  height, and dual valid-blockhash observations.
  Active or pending local state refuses another authorization or submission
  until terminal reconciliation. Signed transaction bytes are public recovery
  evidence but never appear in CLI output or diagnostics; signer secret bytes
  are never persisted or logged.
- Authenticated hosted GET/POST responses expose only the existing public audit
  record and registration projection. They never serialize the private
  `preparedTransaction` field or its base64 bytes.
- Reconciliation uses the persisted signer address and therefore does not
  require the current signer secret or assume that the configured signer has
  not rotated. Only dual explicit `TRANSACTION_EXECUTION_FAILED` results may
  close a pending signature as failed; proof ambiguity remains pending.
- Authorized smoke and production operation require a verified public-key pin
  and sufficient monitored balance on the same Compass-controlled fee payer.
  Low balance blocks new operation until that authority is replenished and
  reverified; no fallback payer or key substitution is allowed.

## Legacy pending exact-once recovery

New prepared state MUST durably retain the signature-bound `recentBlockhash`
and `lastValidBlockHeight` before `sendTransaction` is reachable. Historical
v1 pending manifests remain readable, preserve their original identifiers,
signer, signature, commitment, Memo, and timestamps, and migrate to blocking
`legacy_pending`; missing expiry evidence is never inferred from age or a null
status.

A legacy operator may enrich, but never close, that state with one bounded
base64 signed-transaction evidence file. The import requires an authorization
ID, operator, reason, authorization timestamp, and the exact documented risk
acknowledgement. Compass verifies the persisted signature and signer against
the serialized transaction, derives its recent blockhash, stores only a
transaction SHA-256 plus derived/public metadata, and never stores the
transaction or secret key.

Terminal reconciliation is limited to:

- `confirmed`: both literal Solana devnet and Magic Router independently
  verify the same landed transaction;
- `failed`: both independently report explicit execution failure for the same
  signature;
- `expired_not_landed`: both independently report no signature and
  finalized `isBlockhashValid=false` for the signature-bound blockhash, then
  re-query the signature at an equal-or-later context slot, additionally
  requiring `getBlockHeight > lastValidBlockHeight` whenever an endpoint
  returns height and the bound height exists;
- `not_submitted`: only the pre-prepare `active` state, where code ordering
  proves send was unreachable.

Any endpoint disagreement, unavailable/malformed evidence, missing legacy
blockhash, swapped endpoint/signature/blockhash binding, stale context ordering,
or replay with a conflicting outcome remains blocking. A successful submit
also stays pending until this dual-endpoint reconciliation confirms it.

## Signature-only administrative quarantine

A Solana transaction signature is an Ed25519 signature over the serialized
`Message`; the message contains the recent blockhash and instructions. The
signature therefore cannot be inverted into the missing transaction bytes.
Likewise, `getSignatureStatuses` or `getTransaction` returning null means only
that the queried endpoint did not find the transaction; even two null results
are endpoint-relative observations, not mathematical proof of non-execution.

The exact signature-only v1 incident state may be administratively
`quarantined` only when verified serialized bytes are unavailable, after a
fresh read-only check. Quarantine preserves the signer, signature, timestamps,
and all original evidence; records `historicalOutcome="unknown"`; records why
terminalization is impossible; binds operator, authorization ID, incident
reference, reason, timestamps, the exact acknowledgement, and sanitized
endpoint observations (or a closed unavailability reason); and is idempotent
and conflict-safe. Agreeing confirmed or execution-failed evidence must use
normal reconciliation instead.

Quarantine is not a terminal outcome for the old audit and never retries its
signature. It is limited to the Compass devnet audit-Memo smoke lane, attests
`valueTransferLamports=0` and no payment execution, and explicitly leaves every
generic payment/execution fence closed. The repo-owned authorization workflow
may archive the quarantine and create one new run with a new audit event ID.
The archived quarantine remains immutable history. Residual risk is bounded to
at most one additional devnet Memo transaction and fee, never a user payment.
Fee schedule documentation is not execution proof, and a failed Solana
transaction may still charge a fee.
