# MagicBlock Devnet Runtime Foundation Verification Report

Date: 2026-07-29

## Wave 14A focused preflight

Status: **PASS**

Command:

```text
npm run preflight:magicblock-devnet
```

Evidence:

- Dependency closure: PASS; all 10 core runtime roots have one dedicated audit-ingress entrypoint. Only five explicitly named ingress/persistence/composition modules may directly consume feature roots; transitive helpers receive no privilege.
- Focused Vitest: PASS; 4 files and 95 tests.
- Focused Vitest covers the official one-base58-string request, integer IDs, required `isDelegated`, documented optional metadata, rejection of the former Compass envelope, unsigned v0/no-ALT decoding, the eight-account limit, internally derived account flags, request-scoped immutable source/store behavior, four-call provider concurrency, the shared eight-second deadline, literal URL and redirect enforcement, stream cancellation over 16384 bytes, disabled and separately authenticated ingress behavior, bounded stale-claim recovery, claim-attempt fencing, idempotent observation replay/conflict handling, causally ordered and guarded Postgres singleton-tip advance plus ledger append plus observation completion, missing-tip rollback/recovery, lost-response reconciliation, prior-digest preservation, SHA-256 ledger links, fail-closed redaction, and prior preflight binding/TOCTOU/parser cases.
- Closure fixtures cover every required root, the exact five-module audit-ingress allowlist, an unauthorized transitive consumer, MCP dispatcher, policy/execution reverse and forward edges, sibling bridges, unresolved/nonliteral/out-of-root imports, global nonliteral dynamic imports, and prohibited runtime capabilities.
- All transport tests inject a fake fetch implementation. Integration tests use fakes and in-process PGlite. No live MagicBlock, Solana, or external endpoint was called.

## Confirmed review remediation

Status: **PASS**

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

56 files passed, 2 live suites skipped; 626 tests passed and 22 live tests skipped.

```text
npm run lint
npm run build
```

Both exited successfully. The production build includes the dynamic `/api/magicblock-devnet/audit` route.

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

No Wave 14A diagnostic was emitted after correcting the focused test types. The unrelated test import remains untouched.

## Strategic Board sentinel

Status: **EXPECTED BLOCKED**

Command:

```text
npm run preflight:magicblock-devnet:strategic-gate
```

The expected non-zero result continues to block checkpoint, trust-anchor, registry, custody, and strategic/external activation work. It does not invalidate this disabled runtime foundation.

## Environment note

`npm ci` is currently blocked because the pre-existing `package-lock.json` is not synchronized with `package.json` (missing existing Solana transitive dependencies). Verification installed dependencies with `npm install --no-package-lock --ignore-scripts --no-audit --no-fund`; neither dependency manifest was regenerated by that install.
