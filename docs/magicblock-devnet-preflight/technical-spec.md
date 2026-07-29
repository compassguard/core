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
`https://devnet-router.magicblock.app/` for `getLatestBlockhash` and
`sendTransaction`. Verification uses only the compile-time literal
`https://api.devnet.solana.com/`. Redirects, alternate clusters, and endpoint
configuration are rejected.

References:

- Magic Router: <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router>
- Solana Memo transaction: <https://solana.com/developers/cookbook/transactions/add-memo>
- Solana `getTransaction`: <https://solana.com/docs/rpc/http/gettransaction>

## Contracts

Shared on-chain contracts live in
`back/services/magicBlockOnchainAuditContracts.ts`; signing, submission, and
verification behavior lives separately in
`back/services/magicBlockOnchainAudit.ts`.

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

`magicblock_devnet_onchain_audits` stores:

- observation and audit IDs;
- canonical private details;
- commitment digest and exact Memo;
- registration status, code, signature, signer, slot, and verification time.

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

`COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY` optionally pins the expected
public key. Invalid, oversized, unreadable, relative-path, or mismatched inputs
disable the signer. Secrets are never logged or returned.

Submission builds one legacy Solana transaction with the audit authority as fee
payer and required Memo signer. Magic Router performs preflight and submission.
Independent verification calls `getSignatureStatuses` and `getTransaction`,
decodes the compiled Memo instruction, validates the Memo program ID and signer
index, then compares the exact expected Memo and commitment digest.

## HTTP behavior

The route is absent unless `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true` and
uses a dedicated bearer. `POST` returns `200` only after confirmed on-chain
verification; retryable registration returns `503` with the stable audit
metadata. `GET ?auditId=...` or `GET ?signature=...` refreshes verification and
uses the same success rule.

The MCP client awaits the hosted result with a 20-second default and 45-second
maximum. It accepts only a closed confirmed proof. All other outcomes are
attached to the Compass result as `retryable_failure`.

## Live devnet smoke

Prerequisites are a dedicated audit keypair funded with devnet SOL and the
three signer variables above. No user/mainnet key may be used. Run:

```sh
npm run smoke:magicblock-devnet-onchain
```

Successful output contains only the public audit ID, signer, signature, slot,
commitment digest, and
`https://explorer.solana.com/tx/<signature>?cluster=devnet`. If the credential
is unavailable, deterministic injected-RPC tests are the verification evidence
and live proof remains explicitly blocked.
