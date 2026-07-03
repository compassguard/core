# Proposal: Restructure Hosted Backend as Top-Level Directory

## Intent

Hosted Vercel-deployable code sits inside `back/services/hosted/` alongside local-only code (MCP proxy, domain gateways). This makes deployment boundaries unclear — Vercel's bundler could pull in local-only modules, and developers can't tell at a glance what ships to production. Restructuring separates the two worlds explicitly.

## Product Value

- **Deploy confidence**: `hosted/` is self-contained; Vercel bundles only what reaches `api/hosted/`.
- **Developer clarity**: a glance at the top-level dirs tells you what deploys where.
- **Safe local iteration**: changes to `back/mcp/` or `back/domains/` can't accidentally break hosted.
- **Cleaner contracts**: shared types live in one place; no reverse imports from local → hosted.

## Architecture Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `hosted/` becomes top-level directory | Deployment boundary is visible at repo root |
| 2 | `shared/` holds **types and contracts only** | Prevents code coupling; both sides import types, not logic |
| 3 | `api/hosted/` stays thin — creates app, forwards request | No business logic in the Vercel adapter |
| 4 | Local code (MCP, domains, guardrail execution) never imports from `hosted/` | Kills reverse dependency; shared types replace it |
| 5 | `back/guardrail/policy/` and `back/guardrail/execution/` keep runtime code | Hosted imports them (tree-shaken by bundler) or copies what it needs |

## Current vs Proposed

```
# CURRENT
back/services/
  hosted/            ← deploys to Vercel, imported by local code
  mcp/               ← local-only
  guardrail/         ← shared runtime + contracts mixed
  intelligence/      ← shared prompt
  domains/           ← local-only

# PROPOSED
hosted/              ← top-level, deploys to Vercel
  app.ts, server.ts, evaluate/, audit/, policies/,
  health/, http/, llm/, policy/
shared/              ← types/contracts only (no runtime code)
  types/
    executionGatewayContracts.ts
    policyContracts.ts
    evaluationContracts.ts
    llmDecisionContracts.ts
    llmRouterContracts.ts
back/
  mcp/               ← local-only
  guardrail/         ← local execution only
  domains/           ← local-only
api/hosted/          ← thin adapter (unchanged)
```

## Scope

### In Scope
- Move `back/services/hosted/` → `hosted/`
- Extract shared contracts → `shared/types/`
- Update all import paths (hosted, mcp, domains, guardrail, tests)
- Update `api/hosted/[[...route]].ts` import path
- Vercel config adjustments if needed
- Verify all existing tests pass

### Out of Scope
- New features or runtime behavior changes
- Renaming or refactoring individual modules
- Changing the API surface of hosted endpoints
- Migrating test framework or adding new tests

## File Moves

### Entire directory → `hosted/`

| Source | Destination |
|--------|-------------|
| `back/services/hosted/app.ts` | `hosted/app.ts` |
| `back/services/hosted/appContracts.ts` | `hosted/appContracts.ts` |
| `back/services/hosted/server.ts` | `hosted/server.ts` |
| `back/services/hosted/serverContracts.ts` | `hosted/serverContracts.ts` |
| `back/services/hosted/app.test.ts` | `hosted/app.test.ts` |
| `back/services/hosted/evaluate/*` | `hosted/evaluate/*` |
| `back/services/hosted/audit/*` | `hosted/audit/*` |
| `back/services/hosted/policies/*` | `hosted/policies/*` |
| `back/services/hosted/health/*` | `hosted/health/*` |
| `back/services/hosted/http/*` | `hosted/http/*` |
| `back/services/hosted/policy/*` | `hosted/policy/*` |

### Contracts → `shared/types/`

| Source | Destination | Used by |
|--------|-------------|---------|
| `back/services/guardrail/execution/executionGatewayContracts.ts` | `shared/types/executionGatewayContracts.ts` | hosted, guardrail, domains, mcp |
| `back/services/hosted/policy/policyContracts.ts` | `shared/types/policyContracts.ts` | hosted, domains, guardrail |
| `back/services/hosted/evaluate/evaluationContracts.ts` | `shared/types/evaluationContracts.ts` | hosted, mcp proxy |
| `back/services/hosted/llm/llmDecisionContracts.ts` | `shared/types/llmDecisionContracts.ts` | hosted, mcp proxy, tests |
| `back/services/hosted/llm/llmRouterContracts.ts` | `shared/types/llmRouterContracts.ts` | hosted, mcp proxy |
| `back/services/hosted/http/hostedAuthMiddlewareContracts.ts` | `shared/types/hostedAuthMiddlewareContracts.ts` | hosted, future shared |
| `back/services/hosted/http/hostedErrorMiddlewareContracts.ts` | `shared/types/hostedErrorMiddlewareContracts.ts` | hosted, future shared |

### Runtime code stays in `back/`

| Source | Stays | Notes |
|--------|-------|-------|
| `back/services/guardrail/execution/executionGateway.ts` | `back/guardrail/execution/` | Runtime logic — hosted imports it |
| `back/services/guardrail/debugLogger.ts` | `back/guardrail/` | Runtime — hosted imports it |
| `back/services/guardrail/policy/*` | `back/guardrail/policy/` | Runtime — hosted imports it |
| `back/services/intelligence/llm-router/llmRouterPrompt.ts` | `back/intelligence/llm-router/` | Runtime — hosted imports it |

## Shared Types Strategy

Contracts moved to `shared/types/` contain **only** TypeScript types, interfaces, enums, and Zod schemas. No runtime logic, no side effects, no I/O. This lets both `hosted/` and `back/` import the same contract without creating a bundling dependency on the other's runtime code.

After extraction, local code that previously imported from `hosted/` imports from `shared/types/` instead. Hosted code that previously imported from `guardrail/execution/executionGatewayContracts` also imports from `shared/types/`.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Import path breakage across 20+ files | High | Systematic find-and-replace; run full test suite after every batch |
| Circular dependency if shared/ gains runtime code | Low | ESLint no-restricted-imports rule on `shared/` — types only |
| Vercel config needs updated `includePaths` | Medium | Test Vercel build locally with `vercel build`; add `shared/` to `tsconfig.paths` |
| Tests reference old `../hosted/` paths | High | Move tests with their modules; update imports mechanically |
| `back/guardrail/` runtime imported by hosted at deploy time | Medium | Acceptable — Vercel tree-shakes; or copy specific fns into hosted if bundle size becomes an issue |

## Rollback Plan

1. Revert the commit (all moves are git-renames — clean revert).
2. Restore old import paths (single find-replace pass).
3. Remove `shared/` directory.
4. No data migration, no config drift — pure file-move change.

## Success Criteria

- [ ] `hosted/` is top-level and self-contained (no imports from `back/mcp/`, `back/domains/`)
- [ ] `back/mcp/` and `back/domains/` import contracts from `shared/types/`, never from `hosted/`
- [ ] All existing tests pass without changes to assertions
- [ ] `api/hosted/[[...route]].ts` is a thin adapter with no business logic
- [ ] `vercel build` succeeds and only bundles `hosted/` + `shared/types/` + referenced `back/` runtime
- [ ] No runtime behavior changes — same HTTP responses, same policy decisions