# Magic Router Live Smoke Incident

## Summary

On 2026-07-29 (America/Argentina/Buenos_Aires; 2026-07-30 UTC), the
production-scoped MagicBlock devnet smoke prepared and signed an audit Memo
transaction but returned the Compass status `ROUTER_UNAVAILABLE`.

`ROUTER_UNAVAILABLE` was not the literal Magic Router response. The current
Compass adapter maps any transport or JSON-RPC exception to that generic status
and discards the underlying HTTP status, RPC code, and sanitized RPC message.
The exact upstream rejection therefore cannot be recovered after the fact.

The strongest available evidence indicates that Compass prepared the
transaction with a blockhash from the wrong execution route.

## Remediation status

The local incident-remediation branch now replaces root `getLatestBlockhash`
with raw official `getBlockhashForAccounts`. It constructs the final legacy
Memo transaction, derives a deterministic deduplicated list containing the fee
payer plus every writable instruction account, validates the direct
`blockhash`/`lastValidBlockHeight` result, and signs only afterward.

Router failures now retain only closed primitive diagnostics: RPC method, HTTP
status, JSON-RPC error code, bounded sanitized message, and safe
request/correlation ID. A recognized `sendTransaction` preflight rejection is
reported as `ROUTER_PREFLIGHT_REJECTED` even when the validated Router endpoint
uses a non-200 HTTP status; generic transport failures remain
`ROUTER_UNAVAILABLE`. Serialized transactions, raw bodies, secrets, private
audit details, arbitrary response keys, and unvalidated URLs are excluded.

Prepared-signature reservation still occurs before send. A retry with an
existing signature verifies it instead of submitting a replacement. The direct
smoke now atomically persists signature, commitment digest, and public Memo in
its ignored local pending manifest before send, together with the prepared
public signer address. A one-run nonce is consumed when the run becomes active;
active/pending state refuses another submission or authorization.
Known-signature reconciliation is non-submitting and uses that stored public
signer rather than the current secret.

Only explicit non-null on-chain execution errors map to
`TRANSACTION_EXECUTION_FAILED`. Null/malformed transaction proof, signer
rotation/mismatch, Memo/commitment mismatch, and other proof ambiguity remain
`TRANSACTION_VERIFICATION_FAILED`, keep the manifest pending, and cannot reopen
authorization. Failed reconciliation requires explicit execution failure from
both queried routes.

This is local remediation and deterministic verification only. No deployment,
ingress/MCP enablement, live RPC probe, or transaction-producing smoke was
performed. Independent review and the remaining safe rerun gate still apply.

The dedicated signer is Compass-controlled and MUST remain both fee payer and
required Memo signer. Compass owns its funding and public-balance monitoring.
Authorized smoke and Production operation require verification of the pinned
public key and sufficient balance on that same authority. Low balance is
fail-closed: block new operation, alert without exposing the secret, replenish
the dedicated signer, and reverify balance and pin. Never substitute another
payer or key.

## Scope and safety state

- Cluster: Solana devnet only.
- Vercel project:
  `ramirocshubs-projects/compass-verify-api`
  (`prj_CdxVk7DKmE25AfpdbrFimmJzqXBU`).
- Production domain: `api.compassguard.xyz`.
- Dedicated audit signer:
  `Fpp49ehhybJpUTqQaYingNhnWiQQAVcfcqFQAyL4pVV7`.
- Balance before and after the attempt: `6 SOL`.
- Production variable names present:
  - `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY`
  - `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY`
- The ingress and MCP observer remained disabled.
- No deployment, commit, push, or tracked-file mutation occurred during the
  smoke operation.
- The signer secret is intentionally excluded from this document.

## Attempt evidence

The transaction-producing smoke prepared this signature:

```text
56qrw6n6eYdYbobzF3qAdF9n7QYvRe2ZePrpvT6NSnrfAGqgLP1HzE1cXVNMaF3TJgDTDNHDh9UNcwxXACnTKUVT
```

The smoke then returned:

```text
Devnet audit submission is retryable: ROUTER_UNAVAILABLE
```

Repeated `getSignatureStatuses` queries against both the standard Solana devnet
RPC and Magic Router found no transaction at those endpoints. The signer
balance appeared unchanged. These are endpoint-relative observations only:
null/not-found and balance/fee observations do not mathematically prove that a
transaction never landed or executed. The operation was not retried after a
signature had been prepared.

## Root-cause analysis

### Confirmed defect: upstream errors are erased

`createMagicBlockRouterRpc` throws a generic exception for any non-200 response,
redirect, unexpected final URL, or JSON-RPC error. The outer `register` catch
then converts every exception to `ROUTER_UNAVAILABLE`.

Consequences:

- `ROUTER_UNAVAILABLE` cannot distinguish network failure, preflight rejection,
  invalid blockhash, insufficient funds, unsupported transaction, or another
  JSON-RPC error.
- The original Magic Router code and message were unavailable during incident
  analysis.
- Operators cannot make an evidence-based retry decision from the returned
  result alone.

### High-confidence cause: routing-unsafe blockhash selection

Compass currently calls the root Magic Router method:

```text
getLatestBlockhash
```

It signs the transaction with that blockhash and then calls:

```text
sendTransaction
```

Current live probes showed:

| Probe | Route evidence |
| --- | --- |
| Magic Router `getLatestBlockhash` | ER-side height around `502699926` |
| Magic Router `getBlockhashForAccounts` for the audit payer | Base-layer height around `467685491` |
| Standard Solana devnet blockhash | Base-layer height around `467685405` |
| Audit payer delegation status | `isDelegated: false` |

The routing-aware blockhash matched Solana devnet, while the root
`getLatestBlockhash` result did not. Because the audit payer is not delegated
and the Memo is intended to persist on Solana, Magic Router would route the
transaction to the base layer. A transaction signed with an ER-side blockhash
would then be rejected during base-layer preflight, most likely as an unknown or
expired blockhash.

This is a high-confidence hypothesis rather than a recovered upstream verdict,
because Compass discarded the original Magic Router error.

## Why automated tests passed

The focused tests mock `getLatestBlockhash` with an arbitrary valid public key
and mock `sendTransaction` as successful. They verify transaction construction,
signature reuse, and result-state behavior, but they do not model:

- different blockhash domains for ER and Solana base layer;
- account-aware route selection;
- an undelegated fee payer;
- a base-layer preflight rejection from an ER blockhash;
- preservation of the upstream JSON-RPC error.

The deterministic E2E therefore validates Compass seams but does not prove the
live Magic Router preparation contract.

## Required remediation

Before authorizing another live smoke:

1. Replace root `getLatestBlockhash` preparation with the official
   routing-aware Magic Router flow:
   - preferably `prepareMagicTransaction` or `sendMagicTransaction` from the
     official SDK; or
   - a reviewed `getBlockhashForAccounts` implementation that includes every
     writable account and the fee payer.
2. Preserve safe diagnostic evidence from Magic Router:
   - RPC method;
   - HTTP status;
   - JSON-RPC error code;
   - bounded and sanitized JSON-RPC message;
   - request/correlation identifier when available.
3. Never log the serialized transaction, signer secret, raw request payload, or
   private audit details.
4. Add contract tests covering ER versus base-layer blockhash selection and an
   undelegated audit payer.
5. Add a regression proving that a Router preflight rejection is not collapsed
   into an unactionable generic result.
6. Obtain a fresh independent review of the preparation, diagnostics, and
   exactly-once behavior.

Implementation items 1–5 are addressed locally with focused regression tests.
Item 6 and all live/configuration gate checks remain pending.

## Safe rerun gate

A new smoke is allowed only after all of the following are true:

- the known prepared signature is reconciled once more against Solana devnet
  and Magic Router;
- the routing-aware preparation fix is merged into the test branch;
- focused tests, full tests, lint, application build, and MCP build pass;
- the dedicated signer still has devnet SOL;
- the two Production signer variables still resolve to the expected public key;
- the verified signer balance meets the Compass-approved operational minimum
  and reserve; otherwise alert, replenish that signer, and keep the operation
  blocked;
- one new transaction is explicitly authorized;
- any returned signature is reconciled instead of blindly resubmitted.

The direct smoke does not require enabling the MCP observer. Enabling MCP is a
separate rollout step for validating the complete
tool-result-to-observer-to-ingress-to-Solana path.

The user authorizes Production deployment only after this correction is
independently reviewed and final verification passes. This remediation task
does not perform that deployment or the one authorized live smoke.

## Relevant implementation

- `back/services/magicBlockOnchainAudit.ts`
- `back/services/__tests__/magicBlockOnchainAudit.test.ts`
- `scripts/smoke-magicblock-devnet-onchain.ts`
- `docs/magicblock-devnet-preflight/rollout-runbook.md`

## Official references

- Magic Router overview:
  <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router>
- Magic Router SDK:
  <https://docs.magicblock.gg/pages/tools/magic-router-sdk/getting-started>
- `getBlockhashForAccounts`:
  <https://docs.magicblock.gg/api-reference/er-api/getBlockhashForAccounts>
- Current `getBlockhashForAccounts` equivalent:
  <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getBlockhashForAccounts>

## 2026-07-30 legacy pending recovery correction

The earlier remediation could not safely distinguish a permanently expired
transaction from an unobserved landed transaction because v1 local pending
state omitted the signature-bound blockhash and last-valid height. It also
treated one confirmed endpoint as sufficient. No age or null-status inference
is acceptable for this incident.

The correction versions the smoke manifest, persists blockhash/height before
send for new transactions, requires agreeing terminal evidence from literal
devnet and Magic Router, and adds `expired_not_landed` only for dual
signature-not-found plus invalid-blockhash proof. Historical v1 state stays
blocking. A one-time, explicitly authorized signed-transaction evidence import
can derive its blockhash after cryptographically matching the stored
signer/signature; it stores only a digest and sanitized audit metadata and
cannot close or reset state.

This change makes no RPC call, submission, deployment, or claim that the
incident signature is expired or not landed.

Independent review further required race-free evidence. Each endpoint must now
establish finalized blockhash invalidity before re-reading signature history at
an equal-or-later context, with endpoint, signature, blockhash, slots, and
timestamp persisted. Processed errors and single-endpoint submit confirmation
remain non-terminal.

## 2026-07-31 self-contained recovery and quarantine correction

The historical signature cannot be inverted into its transaction. Solana signs
the serialized Message, and that Message contains the recent blockhash and
instructions. Without verified serialized bytes, neither the signed Memo nor
its expiry window can be reconstructed. `getSignatureStatuses` and
`getTransaction` returning null mean only “not found by this endpoint”; even
dual null is not terminal or mathematical non-execution proof. See the official
[transaction structure](https://solana.com/docs/core/transactions/transaction-structure),
[signature status](https://solana.com/docs/rpc/http/getsignaturestatuses), and
[transaction lookup](https://solana.com/docs/rpc/http/gettransaction)
documentation.

Future direct-smoke state is v3. Before every reachable `sendTransaction`, the
submitter obtains explicit valid-blockhash observations from literal devnet and
Magic Router, signs once, serializes once, and requires the exact base64 plus
plain SHA-256 and all signer/signature/Memo/blockhash bindings to be atomically
fsynced. Every read cryptographically revalidates the bytes. Restarts never
regenerate them, callback changes stop send, and public output never includes
base64 or signer secret material.

For only the exact signature-only v1 incident, an explicitly authorized
`quarantine-legacy` mode performs read-only reconciliation first. Terminal
evidence reconciles normally. Otherwise it preserves the original signer,
signature, and timestamps with `historicalOutcome="unknown"`, the fixed reason
terminalization is impossible, exact operator acknowledgement and authorization
metadata, and bounded endpoint observations. Quarantine is idempotent,
conflict-safe, prohibits retrying the old signature, and is not a terminal
outcome for the old audit.

The quarantine releases only the repo-owned one-run authorization transition
for the Compass devnet audit Memo lane. It attests
`valueTransferLamports=0`, no payment execution, and
`genericExecutionFenceReleased=false`. Authorization archives the quarantine
before creating a new nonce and new audit event ID. The old record remains in
history. Residual exposure is at most one additional devnet Memo transaction
and possible fee, never a user payment. Fee documentation or observed balance
is not execution proof; failed transactions may charge fees. No RPC call,
submission, deployment, secret read, or state mutation was performed while
implementing this correction.
