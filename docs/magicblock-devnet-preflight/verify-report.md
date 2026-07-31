# MagicBlock Devnet On-Chain Audit Verification Report

Date: 2026-07-31

## 2026-07-31 self-contained recovery verification

This correction adds deterministic coverage for the exact signature-only v1
incident quarantine, unknown historical outcome preservation, exact operator
acknowledgement, sanitized endpoint observations/structured unavailability,
idempotent replay and conflict rejection, quarantine history plus one-run
forward authorization, and strict schema rejection. It also covers v3
cryptographic read validation, exact signed bytes and SHA-256 persisted before
send, crashes on both sides of prepared persistence and after submission,
restart duplicate prevention, callback alteration, dual blockhash disagreement,
v1/v2 migration, and absence of secret/base64 material from public results.
The production correction additionally covers claim-fenced PostgreSQL
reservation of the complete prepared object, cryptographic validation on every
read, preservation across retryable and confirmed saves, stale-reclaim fencing
when validity timestamps differ, explicit blockhash-validity diagnosis, mismatch
replay, and base64 exclusion from in-memory POST plus PostgreSQL GET/E2E output.

Current verification performed in this checkout:

- `npm run preflight:magicblock-devnet`: passed dependency closure and 9 files /
  231 tests;
- direct audit + state regression run: passed 2 files / 33 tests;
- direct audit + state + hosted persistence run: passed 3 files / 53 tests;
- complete backend suite: 61 files passed / 2 skipped and 762 tests passed / 22
  skipped;
- `npx tsc --noEmit --pretty false`: reached only the pre-existing unrelated
  missing `../mcp/mcpProxyContracts` import in
  `back/services/__tests__/mcpProxyDispatcher.test.ts`;
- no live RPC, signer credential read, transaction submission, deployment, or
  external state mutation was performed.

The correction does not claim to terminalize the historical signature. A
signature signs a Message but cannot reconstruct that Message; null endpoint
lookups remain non-terminal. Quarantine records
`historicalOutcome="unknown"`, keeps the old signature non-retryable, and
releases only the dedicated devnet audit-Memo one-run workflow. The archived
record explicitly attests zero value-transfer lamports, no payment execution,
and no generic execution-fence release. Residual exposure is at most one new
devnet Memo transaction and possible fee, never a user payment.

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

- focused audit, durable smoke-state, and Postgres store tests: current recovery
  run passed 3 files / 53 tests;
- `npm run preflight:magicblock-devnet`: passed the dependency-closure gate and
  9 files / 231 tests;
- `npm run test:back` outside the sandbox: passed with 61 files passed / 2
  skipped and 762 tests passed / 22 skipped;
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

Final independent remediation verification closed all blocker, high, and
medium findings. Its focused local evidence passed 3 files / 53 tests without
network access, RPC calls, or external mutation; it does not claim live
verification.

No live RPC, transaction smoke, deployment, Vercel mutation, ingress/MCP
enablement, or transaction submission is claimed. A permanently unresolved
self-contained prepared signature remains fail-closed. For the distinct
historical signature-only v1 incident, the exact supported forward path is the
implemented administrative quarantine: it preserves outcome `unknown`,
prohibits retrying the old signature, and permits only one newly authorized
devnet audit-Memo run without releasing any payment or generic execution fence.
Evidence enrichment plus dual expired-and-not-landed proof remains the terminal
reconciliation path when matching historical bytes are available.

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

## 2026-07-30 legacy recovery verification

Focused local verification covers v2 prepared evidence, exact v1 reads,
cryptographic legacy enrichment without raw transaction/secret retention,
dual-endpoint disagreement, missing expiry evidence, dual expiry proof,
conflicting/idempotent replay, and bounded diagnostics. The implementation
does not infer expiry from age, missing status, or an operator assertion and
does not perform a live RPC or transaction.

Current commands and final integration results are recorded in `task.json`.

- `npm run preflight:magicblock-devnet`: pass, dependency-closure gate plus
  9 files / 222 tests.
- `npm run test:back`: pass outside the filesystem sandbox on Node 26.4.0,
  61 files / 753 tests; 2 live suites / 22 tests skipped.
- `npm run lint -- --quiet`, `npm run build`, and `npm run build:mcp`: pass.
- `npm ci --ignore-scripts` and its dry run: pass after regenerating the stale
  lockfile from the existing `package.json`.
- `npx tsc --noEmit --pretty false`: blocked only by the pre-existing missing
  `../mcp/mcpProxyContracts` test import in
  `back/services/__tests__/mcpProxyDispatcher.test.ts`.

The independent-review remediation adds focused regressions for post-expiry
context ordering/landing race, swapped signature/blockhash evidence,
processed-fork execution errors, evidence-file isolation, and dual
reconciliation after submit.

The initially reported Node 26 stdio failure was reproduced inside the
filesystem sandbox as `listen EPERM` for the `tsx` IPC socket (and localhost in
the hybrid suite). The same stdio test and the full backend suite passed
outside that sandbox on Node 26.4.0, proving the failure is environmental and
unrelated to this branch; no stdio code change was made.

The operator decision gate received no answer before timeout, so verification
records the fail-closed default: the incident remains `legacy_pending`, no
replacement is authorized, and the connector operator's next action is limited
to read-only recovery of the original signed transaction evidence. Without
that cryptographically verifiable evidence, the existing historical state is
not safely terminalizable.
