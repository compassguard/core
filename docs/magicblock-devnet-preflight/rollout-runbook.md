# MagicBlock Devnet On-Chain Audit Rollout Runbook

## Preconditions

1. Run `npm run preflight:magicblock-devnet`, `npm test`, `npm run lint`,
   `npm run build`, and `npm run build:mcp`.
2. Provision durable `COMPASS_VERDICT_DB_URL`.
3. Provision dedicated ingress and MCP bearer delivery.
4. Provision the dedicated Compass-controlled audit keypair funded with devnet
   SOL. It MUST remain both fee payer and required Memo signer. Never reuse or
   substitute a user, treasury, demo, mainnet, or fallback signer.
5. Pin its public key with
   `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY`.
6. Verify the pin resolves to the expected public key and that the same public
   account meets the Compass-approved minimum balance for the planned
   operation and reserve.
7. Reconcile the incident's known prepared signature against both literal
   Solana devnet RPC and Magic Router using the non-submitting mode below.
8. Obtain independent review of blockhash routing, bounded diagnostics, and
   exactly-once behavior.
9. Authorize one new devnet transaction only after every safe rerun gate item
   is complete.

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

For Vercel Production, configure the hosted values only in project
`ramirocshubs-projects/compass-verify-api`
(`prj_CdxVk7DKmE25AfpdbrFimmJzqXBU`, domain
`api.compassguard.xyz`). Use exactly one signer secret source; its value, the
database URL, and bearer values are operator-owned secrets and must not appear
in tickets, logs, or smoke output. The MCP values belong to the deployed MCP
process, not to the hosted Vercel ingress.

## Connector-operator handoff after reviewed merge

The user authorizes Production deployment only after the correction has passed
independent review and final verification. This code task performs no merge,
deployment, Production configuration mutation, live RPC call, or live smoke.
After those gates are green, the connector operator must complete and record
this checklist:

1. Preserve the two-stage stacked merge order:
   - open and review the new incident-remediation PR from
     `ram4-dev/magic-router-incident-remediation` into the parent branch
     `ram4-dev/magicblock-onchain-audit-review`, then merge it there;
   - only after that merge updates the parent branch, review and merge the
     still-open parent PR #20 into `release/compass_migration`.
   Neither PR targets `main`. Resolve the reviewed resulting release merge
   commit—or an exact commit explicitly instructed after both merges—and use
   that as the Vercel Production deployment source. Never deploy an unmerged
   feature head, the pre-remediation parent head, or an older stack commit.
2. In Vercel Production for `ramirocshubs-projects/compass-verify-api`, verify:
   - `COMPASS_VERDICT_DB_URL` is the intended durable database;
   - `COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY` is the dedicated hosted bearer;
   - exactly one of `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY` or
     `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE` is configured;
   - `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY` is the approved pin;
   - `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED` remains `false` until the
     deployment, auth, signer, balance, and reconciliation checks pass.
3. In the MCP deployment, verify the separately mapped
   `COMPASS_MAGICBLOCK_MCP_AUDIT_URL`,
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY`, and optional bounded
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_TIMEOUT_MS`. Keep
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=false` until hosted verification
   and the direct smoke succeed.
4. Derive the public key from the configured signer secret without printing the
   secret. Require an exact match with
   `COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY`, confirm that address is
   the transaction fee payer, and read its public devnet balance. If the balance
   is below the Compass-approved minimum and reserve, keep both flags disabled,
   alert the Compass owner, replenish only this signer, and repeat the pin and
   balance checks. Never substitute another payer/key.
5. Reconcile the incident signature first. Then perform exactly one direct
   devnet smoke using the durable `authorize`, `submit`, and `reconcile` modes
   below. Consume one nonce once. A successful `submit` already writes terminal
   reconciled state; invoke `reconcile` to read that state or to resolve any
   interruption/retryable result, and never authorize or submit a replacement
   while it is unresolved.
6. Enable `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true`, verify authenticated
   hosted ingress, then enable one devnet-only MCP instance with
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=true`.
7. Verify one eligible observation persists exactly one ledger event and
   on-chain audit record. Query the authenticated route by both audit ID and
   signature and require the same confirmed signer, Memo, and commitment.
   Retain only public IDs/signatures and sanitized operational evidence.
8. If any gate fails, execute Rollback below: disable the MCP observer first,
   stop audit-dependent producing flows, reconcile every prepared signature,
   then disable ingress. Record the deployed commit and failure without secret
   values.

## Staged rollout

1. Keep both `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED` and
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED` disabled while verifying the
   reviewed deployment, signer pin, balance, and durable state.
2. Reconcile the known prepared signature without submitting:

   ```sh
   COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNATURE=<known-signature> \
   COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNER=<prepared-public-signer> \
     npm run smoke:magicblock-devnet-onchain -- reconcile
   ```

   If both sources cannot produce a terminal result, the local
   `legacy_pending` manifest remains and the rollout stays blocked.
3. Confirm focused tests, full tests, lint, application build, MCP build, signer
   balance, and expected pinned public key. Confirm independent review approval.
4. Atomically create exactly one authorization nonce:

   ```sh
   npm run smoke:magicblock-devnet-onchain -- authorize
   ```

5. Consume the emitted nonce exactly once:

   ```sh
   COMPASS_MAGICBLOCK_DEVNET_AUTHORIZATION_NONCE=<nonce> \
     npm run smoke:magicblock-devnet-onchain -- submit
   ```

   Retain only its public signature, slot, commitment, and devnet explorer URL.
   On a retryable result or process interruption, run
   `npm run smoke:magicblock-devnet-onchain -- reconcile`; never invoke another
   `submit` for that state.
6. Enable hosted ingress with
   `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true` and prove unauthenticated
   POST/GET return `401`.
7. Enable one devnet-only MCP instance with
   `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=true`.
8. Exercise one eligible result and confirm:
   - `structuredContent.compassAudit.outcome` is `confirmed`;
   - Postgres has one observation, ledger event, and on-chain audit record;
   - GET by both audit ID and signature returns the same verified commitment;
   - the Memo contains no raw transaction, request, result, or secret.
9. Exercise an unavailable transport and confirm the MCP result carries
   `retryable_failure` and the observation is not completed.
10. Expand only after monitoring confirmation latency, retryable rate, signer
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
  details with the actual Memo and stored prepared signer. This is proof
  ambiguity, not evidence that a landed transaction failed; keep pending.
- `TRANSACTION_EXECUTION_FAILED`: terminal execution failure is eligible for
  failed reconciliation only when both Solana devnet RPC and Magic Router
  independently return this explicit result for the prepared signature.
- `ROUTER_PREFLIGHT_REJECTED`: stop automatic retry, preserve the allowlisted
  Router diagnostics, and reconcile any prepared signature before deciding on
  operator recovery.
- `ROUTER_UNAVAILABLE` or `AUDIT_TIMEOUT`: keep the result retryable; investigate
  Magic Router, Solana devnet RPC, and route duration.
- Low signer balance: fail closed. Keep ingress/observer or new audited
  operation disabled, alert the Compass owner without secret material,
  replenish only the dedicated Compass-controlled fee payer, and reverify its
  public balance and pinned key before continuing. Never substitute a fallback
  payer/key.
- Repeated expired prepared signature: use an operator recovery procedure
  before replacement; never silently create competing audit records.

## Local smoke-state recovery

- The default ignored state directory is
  `.compass-magicblock-devnet-smoke/`.
- Never delete or edit `state.json` to bypass `active`, `pending`, or
  `legacy_pending`.
- `active` can be transitioned by the `reconcile` mode to
  `reconciled/not_submitted` because send is unreachable until `pending` is
  durably written.
- `pending` and `legacy_pending` transition only after confirmed proof or an
  unambiguous dual `TRANSACTION_EXECUTION_FAILED`. Null/malformed
  `getTransaction`, stored-signer mismatch, Memo/commitment mismatch, and
  unconfirmed/not-found results are ambiguous and stay blocked.
- Reconciliation reads the public signer from the pending manifest. It does not
  require the old signer secret after rotation. Importing a legacy signature
  requires its prepared public signer through
  `COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNER` (or the unchanged public-key
  pin).
- If a process dies while holding `state.lock`, first prove no smoke process is
  still running, preserve `state.json`, remove only the stale lock, and run
  `reconcile`. Never remove a lock while a smoke process may still be active.
