# MagicBlock Devnet On-Chain Audit Rollout Runbook

## Preconditions

1. Run `npm run preflight:magicblock-devnet`, `npm test`, `npm run lint`,
   `npm run build`, and `npm run build:mcp`.
2. Provision durable `COMPASS_VERDICT_DB_URL`.
3. Provision dedicated ingress and MCP bearer delivery.
4. Provision a dedicated audit keypair funded with devnet SOL. Never reuse a
   user, treasury, demo, or mainnet signer.
5. Pin its public key with
   `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY`.
6. Run `npm run smoke:magicblock-devnet-onchain` and retain only its public
   signature, slot, commitment, and devnet explorer URL.

## Configuration

Hosted ingress:

```text
COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true
COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY=<dedicated bearer>
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY=<base58 or JSON key bytes>
# or COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE=<absolute path>
COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY=<pinned public key>
COMPASS_VERDICT_DB_URL=<durable Postgres URL>
```

MCP process:

```text
COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=true
COMPASS_MAGICBLOCK_MCP_AUDIT_URL=https://<host>/api/magicblock-devnet/audit
COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY=<explicitly mapped bearer>
COMPASS_MAGICBLOCK_MCP_OBSERVER_TIMEOUT_MS=20000
```

The timeout may be 1–45000ms. Mainnet is not configurable.

## Staged rollout

1. Keep the MCP observer disabled.
2. Enable hosted ingress and prove unauthenticated POST/GET return `401`.
3. Run the live smoke and confirm its exact Memo on Solana devnet.
4. Enable one devnet-only MCP instance.
5. Exercise one eligible result and confirm:
   - `structuredContent.compassAudit.outcome` is `confirmed`;
   - Postgres has one observation, ledger event, and on-chain audit record;
   - GET by both audit ID and signature returns the same verified commitment;
   - the Memo contains no raw transaction, request, result, or secret.
6. Exercise an unavailable transport and confirm the MCP result carries
   `retryable_failure` and the observation is not completed.
7. Expand only after monitoring confirmation latency, retryable rate, signer
   balance, and duplicate/conflict errors.

## Rollback

1. Disable `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED`.
2. Stop affected transaction-producing flows that require the audit guarantee;
   do not describe unaudited operation as successful.
3. Disable hosted ingress after in-flight prepared signatures are reconciled.
4. Preserve the private ledger, audit records, public signatures, and signer
   rotation evidence. On-chain Memo transactions are immutable.
5. Rotate the ingress bearer or audit signer if exposure is suspected.

## Failure handling

- `SUBMISSION_UNCONFIRMED`: query by signature and retry after the claim lease.
- `TRANSACTION_VERIFICATION_FAILED`: stop rollout and compare stored canonical
  details with the actual Memo and signer.
- `ROUTER_UNAVAILABLE` or `AUDIT_TIMEOUT`: keep the result retryable; investigate
  Magic Router, Solana devnet RPC, and route duration.
- Low signer balance: replenish only the dedicated devnet authority.
- Repeated expired prepared signature: use an operator recovery procedure
  before replacement; never silently create competing audit records.
