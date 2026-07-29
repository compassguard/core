# MagicBlock Devnet Runtime and MCP Observer Verification Report

Date: 2026-07-29

## Wave 14B focused preflight

Status: **PASS**

Command:

```text
npm run preflight:magicblock-devnet
```

Evidence:

- Dependency closure: PASS; all 10 core runtime roots have one dedicated audit-ingress entrypoint and one exact seven-module directed MCP observer graph with exact local edges, external imports, counted required-global uses, exact per-role computed-member use tables, and zero permitted binding/destructuring forms. Only the extractor has the enumerated Wave 14A observation-contract/helper ingress; every other observer module has no feature-root reachability, and implementation remains isolated from 27 authorization/execution boundaries.
- Focused Vitest: PASS; 7 files and 188 tests.
- Runtime coverage includes the official one-base58-string request, integer IDs, required `isDelegated`, documented optional metadata, rejection of the former Compass envelope, unsigned v0/no-ALT decoding, the eight-account limit, internally derived account flags, request-scoped immutable source/store behavior, four-call provider concurrency, the shared eight-second deadline, literal URL and redirect enforcement, stream cancellation over 16384 bytes, disabled and separately authenticated ingress behavior, bounded stale-claim recovery, claim-attempt fencing, idempotent observation replay/conflict handling, causally ordered and guarded Postgres singleton-tip advance plus ledger append plus observation completion, missing-tip rollback/recovery, lost-response reconciliation, prior-digest preservation, SHA-256 ledger links, fail-closed redaction, and prior preflight binding/TOCTOU/parser cases.
- MCP observer coverage includes disabled/default-off composition, exact root-only extraction, unused-padding-bit base64 rejection, malformed/irrelevant/extra-key/oversized rejection, detached frozen observations, no text or nested parsing, dedicated config/auth, canonical HTTPS audit-route rules, payload bounding before transport, hard timeout with an abort-ignoring transport, response-body non-consumption, synchronous/async/custom-thenable/late-rejection fail-open behavior, denied/error exclusion, mutation resistance, and exact downstream equality, deep state, and object identity.
- The local E2E crosses linked MCP SDK in-memory transports, `createProxyMcpServer` request-handler wiring, the real dispatcher, a fake `DownstreamMcpClient`, real observer/client, injected hosted-audit transport, hosted ingress, fake MagicBlock provider, and PGlite/Postgres-compatible persistence. It does not inject `proxyCallTool`; it confirms downstream execution, one completed observation, one audit ledger event, and wrong-auth fail-open without persistence.
- Closure fixtures cover every required root, the exact five-module audit ingress, exact local/external dependencies, positive exact global-use forms, and all seven legitimate computed accesses for the seven observer/server files. Negative fixtures cover forbidden feature imports from every non-extractor observer module, extra extractor feature imports, server bypasses, observer-to-dispatcher edges, Solana and `node:child_process` dependencies, static and TypeScript import-type forms, missing required builtins, unresolved and `scripts/` imports, `require`, `createRequire`, dynamic import, aliased `process`, aliased loaders, `process.getBuiltinModule`/`binding`/`dlopen`, `Reflect.get`, computed global names, destructured and indirect fetch, direct/aliased/nested computed Function constructors, `Object.getPrototypeOf`, property descriptors, ordinary and optional unrecognized indexing, duplicate approved computed/global uses, and constructor/`__proto__` extraction through alias, shorthand, nesting, parameter/default, literal/computed property, assignment, loop, and array-binding forms.
- All transport tests inject a fake fetch implementation. Integration tests use fakes and in-process PGlite. No live MagicBlock, Solana, or external endpoint was called.

## Confirmed review remediation

Status: **PASS**

- Independent finding 1: the sink type now accepts only `MagicBlockMcpObservation`; the wrapper extracts a detached frozen copy before invocation and normalizes synchronous/async delivery. Regressions prove sync throw, rejection, mutation attempt, timeout, non-2xx status, and late rejection preserve exact reference and unchanged deep state.
- Independent finding 2: canonical base64 validates unused padding bits and rejects `AB==` and `AAB=` in addition to malformed and oversized forms.
- Independent finding 3: the verifier compares every local direct edge for each named observer/server file with its exact allowlist. Only the extractor may import the observation contract/canonical helper, and negative fixtures cover every other observer module plus extractor/server bypasses.
- Independent finding 4: E2E now uses the actual MCP SDK protocol path, server handler registration, dispatcher, and fake downstream client before reaching the observer, hosted ingress, and PGlite. Wrong hosted-audit authentication is also exercised without persistence.
- Independent finding 5: the verifier now evaluates every raw observer/server import form against exact per-role external and local dependency policies, rejects runtime loader bypasses and out-of-root imports, and the wrapper regression proves a rejecting custom PromiseLike remains fail-open with exact downstream identity and state.
- Independent finding 6: permitted globals are no longer role-wide capabilities. Each approved production occurrence has an exact AST shape, named context, arguments, and count; aliasing, destructuring, reflection, computed lookup, indirect calls, and native/runtime loaders have dedicated negative fixtures.
- Independent finding 7: every runtime computed member access in the seven protected files is checked against an exact role-specific shape and count. The only seven accepted forms are the current extractor/config/server reads; all others, including the exact nested-array/join Function-constructor bypass and Object reflection, fail closed.
- Independent finding 8: the seven protected files now permit zero destructuring binding or assignment forms. Constructor and `__proto__` extraction through aliases, shorthand, nesting, parameters, literal/computed property names, defaults, loops, and array bindings has dedicated negative coverage. This is explicitly a static source-boundary guarantee, not a general JavaScript sandbox claim.
- No independent review was performed by the implementation writer after these accepted fixes.

Wave 14A remediation remains passing:

- The ledger no longer relies on a session advisory lock or a stale pre-lock read. One singleton Postgres tip row serializes appenders. One data-modifying-CTE statement locks the current claim, advances the tip, inserts the immutable event, and completes the observation from that insert; its scalar guard raises an in-statement error unless all four transitions affect exactly one row.
- A missing-tip regression proves that the failed guarded statement leaves the observation pending with no ledger event, after which explicit tip restoration permits the current claimant to retry successfully.
- A concurrent PGlite regression test runs two appends through `Promise.all` and verifies contiguous sequences plus an exact prior-digest link. This is compatibility evidence for the SQL design, not a live Supabase concurrency claim.
- A lost-SQL-response-after-commit test verifies that ingress reconciles the completed observation and returns its audit result without creating another event or downgrading it to `unavailable`.
- The decoder and producer reject a ninth candidate account before provider access. Eight-account collection is ordered and bounded to four concurrent calls, each limited to two seconds and the remaining part of one eight-second ingress deadline. The hosted route declares 15 seconds.
- Pending observation claims use a twelve-second lease and one conditional Postgres upsert. The returned positive `claimAttempt` fences both success append and `unavailable` completion; tests keep claimant 1 alive, reclaim with claimant 2, reject both stale writes, and allow claimant 2 to create exactly one event.
- The closure guard grants direct-consumer privilege by exact file identity, independently validates the ingress closure, and rejects nonliteral dynamic imports anywhere under the scanned source roots.

## Repository test, lint, and build

Status: **PASS**

Commands and results:

```text
npm test
```

59 files passed, 2 live suites skipped; 719 tests passed and 22 live tests skipped.

```text
npm run lint
npm run build
npm run build:mcp
```

All exited successfully. The production build includes the dynamic `/api/magicblock-devnet/audit` route, and the bundled MCP entrypoint includes the observer composition.

## Repository-wide typecheck

Status: **BLOCKED BY PRE-EXISTING UNRELATED ERROR**

Command:

```text
npx tsc --noEmit
```

Evidence:

```text
back/services/__tests__/mcpProxyDispatcher.test.ts(134,29): error TS2307: Cannot find module '../mcp/mcpProxyContracts' or its corresponding type declarations.
```

No Wave 14B diagnostic was emitted. The unrelated test import remains untouched.

## Strategic Board sentinel

Status: **EXPECTED BLOCKED**

Command:

```text
npm run preflight:magicblock-devnet:strategic-gate
```

The expected non-zero result continues to block checkpoint, trust-anchor, registry, custody, and strategic/external activation work. It does not invalidate this disabled runtime foundation.

## Environment note

`npm ci` is currently blocked because the pre-existing `package-lock.json` is not synchronized with `package.json` (missing existing Solana transitive dependencies). Verification installed dependencies with `npm install --no-package-lock --ignore-scripts --no-audit --no-fund`; neither dependency manifest was regenerated by that install.
