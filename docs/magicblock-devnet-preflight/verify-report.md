# MagicBlock Devnet On-Chain Audit Verification Report

Date: 2026-07-30

## Magic Router incident remediation status

The remediation adds deterministic contract coverage for:

- route-aware base-layer versus ER blockhash selection;
- the undelegated fee payer in `getBlockhashForAccounts`;
- fee payer plus every writable account with stable deduplication;
- `onPrepared` occurring exactly once before send and no send after a competing
  reservation;
- upstream Router preflight rejection classification;
- bounded diagnostic sanitization and absence of raw/secret fields;
- sanitized diagnostic persistence and hosted retryable registration output;
- durable one-run smoke authorization, prepared-signature persistence, refusal
  while active/pending, and reconciliation before reauthorization;
- confirmed status plus null transaction proof remaining blocked;
- reconciliation by persisted public signer after signer rotation/current
  secret unavailability; and
- terminal failed reconciliation only for dual explicit on-chain execution
  failure.

Final post-fix verification:

- focused audit, durable smoke-state, and Postgres store tests: 3 files / 35
  tests passed;
- `npm run preflight:magicblock-devnet`: passed the dependency-closure gate and
  9 files / 213 tests;
- `npm run test:back` outside the sandbox: passed with 61 files passed / 2
  skipped and 744 tests passed / 22 skipped;
- `npm run lint`: passed;
- `npm run build`: passed;
- `npm run build:mcp`: passed;
- `npx tsc --noEmit --pretty false`: reaches only the pre-existing unrelated
  missing test import `back/services/__tests__/mcpProxyDispatcher.test.ts` ->
  `../mcp/mcpProxyContracts`; comparison with the branch base proves the same
  missing import exists there;
- `git diff --check`: passed;
- the read-only source incident SHA-256 remains
  `6a3cb83688e69dca01f4e8f30c27858703f512c3a14d82bfc9a152ea5fc30294`.

The initial sandbox run produced environmental `listen EPERM` failures for the
stdio/localhost suites. The unified outside-sandbox `npm run test:back` run
above passed, so those failures are not repository failures.

Independent read-only review and re-reviews report no remaining critical, high,
or medium findings. The sole low documentation finding was the stale targeted
test count, now corrected to 35.

No live RPC, transaction smoke, deployment, Vercel mutation, ingress/MCP
enablement, or transaction submission is claimed. A permanently unresolved
prepared signature remains fail-closed and blocks replacement pending an
operator recovery policy.

## Historical baseline evidence

The following deterministic/repository counts describe the correction baseline
before this Magic Router incident-remediation branch. They are retained for
provenance and are not the current counts reported above.

### Deterministic verification

`npm run preflight:magicblock-devnet` passes the dependency-closure gate and the
focused unit, route, Postgres, observer, submission, verification, and E2E
suite. The closure keeps MagicBlock audit code isolated from authorization,
execution, wallet signing, and transaction sending boundaries while permitting
only the dedicated audit path.

The E2E crosses:

```text
MCP SDK request
-> dispatcher and controlled downstream result
-> awaited hosted audit client
-> authenticated ingress
-> trusted transaction decode and MagicBlock evidence
-> PGlite canonical ledger
-> injected signed-submission seam
-> durable on-chain record
-> GET by audit ID and signature
-> independent verification result
```

It proves a Compass result exposes confirmed proof only after registration and
that wrong authentication yields an explicit retryable state without
persistence. Unit tests separately prove deterministic signing, exact Memo
contents, confirmation polling, compiled instruction decoding, required audit
signer validation, signer file loading, retryable prepared signatures, and
privacy exclusions.

### Repository verification

- `npm run preflight:magicblock-devnet`: pass, 8 files / 201 tests.
- `npm test`: pass, 60 files / 732 tests; 2 live suites / 22 tests skipped.
- `npm run lint`: pass.
- `npm run build`: pass.
- `npm run build:mcp`: pass.
- `node --check scripts/verify-magicblock-preflight-dependency-closure.mjs`:
  pass.
- `npx tsc --noEmit --pretty false`: blocked only by the pre-existing unrelated
  test import `back/services/__tests__/mcpProxyDispatcher.test.ts` ->
  `../mcp/mcpProxyContracts`.

### Live proof

That historical worker had no dedicated funded devnet audit credential. The
later incident scope documented a dedicated signer with 6 devnet SOL at the
time of the attempt. This non-live remediation did not recheck its current
balance or credential configuration and claims no new live signature or
explorer evidence.
