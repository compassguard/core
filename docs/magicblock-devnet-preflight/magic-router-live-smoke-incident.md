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
RPC and Magic Router found no transaction. The signer balance remained
unchanged, providing additional evidence that the transaction did not land.
The operation was not retried after a signature had been prepared.

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
