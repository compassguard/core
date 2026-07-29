# MagicBlock MCP Observer Rollout and Rollback Runbook

## Safety boundary

This runbook covers only the disabled-by-default, devnet audit observer. It does not authorize live endpoint testing from CI, mainnet, policy changes, approval changes, signing, sending, delegation, registry work, or external activation of the blocked strategic checkpoint.

## Preconditions

1. `npm run preflight:magicblock-devnet`, `npm test`, lint, and build pass in an environment using only injected/fake transports and local PGlite. The preflight must report the exact seven-module observer graph; do not roll out after any unexpected or missing observer/server import, changed required-global or computed-member AST use/count, new binding/destructuring pattern, unrecognized indexing, alias or reflective capability access, runtime-loader bypass, unresolved path, or out-of-root dependency.
2. The hosted audit ingress is deployed with `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=true`, a dedicated ingress bearer, and durable `COMPASS_VERDICT_DB_URL`.
3. The MCP process receives a separate `COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY` value that matches the ingress bearer. Do not source it from `COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY` implicitly; secret delivery must map it explicitly.
4. `COMPASS_MAGICBLOCK_MCP_AUDIT_URL` is the canonical HTTPS DNS URL ending exactly in `/api/magicblock-devnet/audit`.
5. The operator has a way to query the hosted observation and audit-ledger tables without exposing raw credentials or transaction material.

## Staged rollout

1. Keep `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED` absent or `false`.
2. Enable and health-check the hosted ingress independently. An unauthenticated request must be rejected and must not create an observation.
3. Configure the observer URL, dedicated observer key, and optionally a timeout from 1 through 1000ms. Use the 500ms default initially.
4. Set `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=true` for one devnet-only MCP instance.
5. Exercise one controlled downstream tool that returns the exact closed unsigned-transaction envelope. Confirm:
   - the MCP SDK result is structurally equal to the downstream result; wrapper-level tests separately prove exact in-process reference identity and unchanged deep state;
   - latency is bounded by the configured observer timeout;
   - exactly one observation reaches a terminal state;
   - a successful evidence path creates exactly one audit-ledger event;
   - denied, approval-required, malformed, irrelevant, extra-key, and downstream-error results create no observation.
6. Expand only after checking timeout/error rate and idempotency behavior. Do not enable mainnet or use the hosted audit response for policy or execution.

## Immediate rollback

1. Set `COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED=false` (or remove it) and restart the affected MCP process.
2. Confirm subsequent allowed tool calls still return normally and create no new MagicBlock observations.
3. Leave the hosted ingress available only if another explicitly approved producer uses it; otherwise set `COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED=false`.
4. Rotate the dedicated bearer if credential exposure is suspected.

Rollback requires no data migration and has no Solana or MagicBlock on-chain effect. Existing append-only audit records remain immutable evidence and must not be deleted as part of feature rollback.

## Failure handling

- Timeout or network failure: observer remains fail-open; disable it if added latency or error volume is unacceptable.
- Authentication failure: verify only the explicit observer-to-ingress secret mapping, then rotate if needed. Never fall back to general hosted or ingress environment names in code.
- Repeated observation ID conflict: stop the producer and correct downstream ID generation; do not overwrite stored observations.
- Unexpected policy, approval, execution, signing, sending, or delegation change: disable the observer immediately and treat it as a boundary violation requiring security review.
