# MagicBlock Devnet Preflight Verification Report

Date: 2026-07-29

## Implemented local slice

Status: **PASS**

Command:

```text
npm run preflight:magicblock-devnet
```

Evidence:

- Dependency closure: PASS; all 6 canonical feature roots isolated from 38 authorization/execution boundary matches.
- Focused Vitest: PASS; 1 file, 64 tests.
- Runtime coverage includes disabled zero-call behavior; the official single-base58-string parameter and integer JSON-RPC ID; required `isDelegated`; documented optional `fqdn` and official delegation-record metadata; rejection of the former Compass request object and invented delegation-record envelope; transport streaming cap; redirect/host, malformed, oversized, over-depth, extra, duplicate, unsafe-integer, and replayed-ID response rejection; candidate/plan/account digest and flag recomputation; writer-derived outcomes; TOCTOU mutation resistance; redaction; append failure; canonical domain-separated digest; opaque candidate-source input; and `simulate_transaction` `ALLOW` isolation.
- Closure fixtures cover all six required roots, forward/reverse reachability, direct and transitive protected unresolved/nonliteral/out-of-root imports, Producer/Types consumption, sibling bridge consumers, feature imports outside source roots, external SDK/non-crypto builtins, direct/global fetch, WebSocket, process/child-process capability bypasses, and comment/string false-positive resistance. Ordinary unrelated bare packages remain accepted.

## Focused static checks

Status: **PASS**

Commands:

```text
./node_modules/.bin/eslint back/services/magicBlockDevnetPreflightTypes.ts back/services/magicBlockDevnetPreflightCanonical.ts back/services/magicBlockDevnetPreflightProducer.ts back/services/magicBlockDevnetPreflightSchema.ts back/services/magicBlockDevnetPreflightAdapter.ts back/services/magicBlockDevnetPreflightAuditWriter.ts back/services/magicBlockDevnetPreflightIntegration.ts back/services/__tests__/magicBlockDevnetPreflight.test.ts scripts/verify-magicblock-preflight-dependency-closure.mjs scripts/verify-magicblock-preflight-approval.mjs
```

```text
./node_modules/.bin/tsc --noEmit --pretty false --target ES2022 --module ESNext --moduleResolution Bundler --lib ESNext,DOM --skipLibCheck back/services/magicBlockDevnetPreflightTypes.ts back/services/magicBlockDevnetPreflightCanonical.ts back/services/magicBlockDevnetPreflightProducer.ts back/services/magicBlockDevnetPreflightSchema.ts back/services/magicBlockDevnetPreflightAdapter.ts back/services/magicBlockDevnetPreflightAuditWriter.ts back/services/magicBlockDevnetPreflightIntegration.ts
```

Both commands exited successfully with no diagnostics.

## Repository closure checks

Status: **PASS WITH KNOWN BASELINE TYPECHECK**

- `npm test`: PASS; 53 files passed, 2 live suites skipped; 595 tests passed, 22 live tests skipped.
- `npm run lint`: PASS.
- `npm run build`: PASS; Next.js production build completed.
- `npm run build:mcp`: PASS.
- MagicBlock task and strategic-baseline JSON parse checks: PASS.
- `git diff --check`: PASS.

## Strategic Board sentinel

Status: **EXPECTED BLOCKED**

Command:

```text
npm run preflight:magicblock-devnet:strategic-gate
```

Evidence: exits non-zero with `immutable Board approval evidence is required; local proposal metadata is non-authoritative and cannot authorize strategic or external action`.

This expected failure blocks only future checkpoint, trust-anchor, registry, custody, and strategic/external activation work. It does not invalidate the completed local evidence-and-audit slice.

## Repository-wide typecheck

Status: **BLOCKED BY PRE-EXISTING UNRELATED ERROR**

Command:

```text
./node_modules/.bin/tsc --noEmit --pretty false
```

Evidence:

```text
back/services/__tests__/mcpProxyDispatcher.test.ts(134,29): error TS2307: Cannot find module '../mcp/mcpProxyContracts' or its corresponding type declarations.
```

The focused MagicBlock TypeScript check passes. This report does not modify the unrelated missing import.

## Dependency setup baseline

`npm ci` cannot reproduce the base checkout because the committed `package.json` and `package-lock.json` are already out of sync (the lockfile omits the `@solana/spl-token` dependency closure). Verification reused the already-installed dependency tree from the Wave 14B worktree without changing either manifest. This remediation adds no dependency and leaves that unrelated lockfile repair out of scope.

## Remaining strategic placeholders

- Immutable Board approval evidence: pending.
- Checkpoint trust anchor and authority rotation design: pending.
- Durable checkpoint replay/revocation state: pending.
- Registry ownership, custody/signing, privacy, permissions, rollout, and rollback: pending.
- Any checkpoint or on-chain registry implementation: not started and not authorized.
