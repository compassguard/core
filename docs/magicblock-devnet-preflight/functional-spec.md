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

`TRANSACTION_EXECUTION_FAILED` is reserved for an explicit non-null on-chain
`status.err` or transaction `meta.err`. Missing/malformed transaction proof,
unexpected signer, Memo/commitment mismatch, or other proof ambiguity remains
`TRANSACTION_VERIFICATION_FAILED` and must not authorize replacement.

## Query and verification

The separately authenticated audit route accepts `GET` with exactly one of
`auditId` or `signature`. It loads the durable record, rematerializes the
expected commitment, reads the transaction from literal Solana devnet RPC, and
returns `200` only for a newly verified confirmed proof. Missing, malformed,
unconfirmed, mismatched, or failed transactions do not verify.

## Acceptance

- Every eligible result exposes either confirmed proof or explicit retryable
  failure.
- Postgres retains the canonical private details and one record per observation,
  audit ID, and signature.
- The Solana Memo exposes no sensitive raw payload.
- A no-live-service E2E proves request -> Compass result -> canonical ledger ->
  signed Magic Router submission -> independent retrieval and verification.
- Live devnet proof is recorded only when a dedicated funded credential is
  available; tests never synthesize a claimed live signature.
- The direct smoke reconciles a supplied known signature without submitting and
  requires a durable, atomically consumed one-run nonce before creating one new
  transaction.
- Before send, its `onPrepared` callback atomically persists only the prepared
  public signer address, signature, commitment digest, public Memo, and closed
  run identifiers. Active or pending local state refuses another authorization
  or submission until terminal reconciliation; it never stores signer secret
  material or serialized transactions.
- Reconciliation uses the persisted signer address and therefore does not
  require the current signer secret or assume that the configured signer has
  not rotated. Only dual explicit `TRANSACTION_EXECUTION_FAILED` results may
  close a pending signature as failed; proof ambiguity remains pending.
- Authorized smoke and production operation require a verified public-key pin
  and sufficient monitored balance on the same Compass-controlled fee payer.
  Low balance blocks new operation until that authority is replenished and
  reverified; no fallback payer or key substitution is allowed.
