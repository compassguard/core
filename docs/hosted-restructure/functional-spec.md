# Functional Spec: Hosted Backend Restructure

## 1. Overview

This spec covers the Compass MCP Guard hosted backend restructure: move Vercel-deployable hosted code from `back/services/hosted/` to top-level `hosted/`, extract shared contracts to `shared/types/`, keep local-only MCP/domain/runtime code under `back/`, and preserve existing runtime behavior, tests, and rollback safety.

## 2. Actor and System Boundaries

- **Hosted backend:** `hosted/` contains the deployable Hono app, HTTP middleware, hosted routes, policy/evaluation/audit services, LLM adapters, and the local Bun entrypoint.
- **Vercel adapter:** `api/hosted/[[...route]].ts` remains a thin request adapter and MUST import the hosted app from `hosted/`.
- **Shared contracts:** `shared/types/` contains only shared TypeScript contracts: types, interfaces, enums, and schemas.
- **Local backend:** `back/` retains local MCP server code, domains, guardrail execution runtime, guardrail policy runtime, and intelligence runtime.
- **Forbidden dependency direction:** `back/mcp/` and `back/domains/` MUST NOT import from `hosted/`; they MAY import contracts from `shared/types/`.

## 3. Functional Requirements

### File Move Requirements

#### FR-MOVE-001: Hosted root files
The system MUST move these files without renaming their module purpose:

| Source | Destination |
|---|---|
| `back/services/hosted/app.ts` | `hosted/app.ts` |
| `back/services/hosted/appContracts.ts` | `hosted/appContracts.ts` |
| `back/services/hosted/server.ts` | `hosted/server.ts` |
| `back/services/hosted/serverContracts.ts` | `hosted/serverContracts.ts` |
| `back/services/hosted/app.test.ts` | `hosted/app.test.ts` |

#### FR-MOVE-002: Hosted feature directories
The system MUST move hosted runtime and route files as follows:

| Source | Destination |
|---|---|
| `back/services/hosted/audit/*` | `hosted/audit/*` |
| `back/services/hosted/evaluate/*` | `hosted/evaluate/*` |
| `back/services/hosted/health/*` | `hosted/health/*` |
| `back/services/hosted/http/*` | `hosted/http/*` |
| `back/services/hosted/llm/*` | `hosted/llm/*` |
| `back/services/hosted/policies/*` | `hosted/policies/*` |
| `back/services/hosted/policy/*` | `hosted/policy/*` |

#### FR-MOVE-003: Local runtime placement
The system MUST keep local runtime code in `back/` and MUST NOT move it into `hosted/` or `shared/types/`.

| Source | Destination |
|---|---|
| `back/services/guardrail/execution/executionGateway.ts` | `back/guardrail/execution/executionGateway.ts` |
| `back/services/guardrail/debugLogger.ts` | `back/guardrail/debugLogger.ts` |
| `back/services/guardrail/policy/*` | `back/guardrail/policy/*` |
| `back/services/intelligence/llm-router/llmRouterPrompt.ts` | `back/intelligence/llm-router/llmRouterPrompt.ts` |

### Shared Types Extraction Requirements

#### FR-SHARED-001: Shared contract extraction
The system MUST extract these contracts to `shared/types/`:

| Source | Destination |
|---|---|
| `back/services/guardrail/execution/executionGatewayContracts.ts` | `shared/types/executionGatewayContracts.ts` |
| `back/services/hosted/policy/policyContracts.ts` | `shared/types/policyContracts.ts` |
| `back/services/hosted/evaluate/evaluationContracts.ts` | `shared/types/evaluationContracts.ts` |
| `back/services/hosted/llm/llmDecisionContracts.ts` | `shared/types/llmDecisionContracts.ts` |
| `back/services/hosted/llm/llmRouterContracts.ts` | `shared/types/llmRouterContracts.ts` |
| `back/services/hosted/http/hostedAuthMiddlewareContracts.ts` | `shared/types/hostedAuthMiddlewareContracts.ts` |
| `back/services/hosted/http/hostedErrorMiddlewareContracts.ts` | `shared/types/hostedErrorMiddlewareContracts.ts` |

#### FR-SHARED-002: Shared content limit
Files under `shared/types/` MUST contain only contracts and schemas. They MUST NOT contain business logic, network calls, filesystem access, environment reads, server startup code, or route handlers.

#### FR-SHARED-003: Shared consumers
Hosted, guardrail, domain, MCP, and test code that need extracted contracts MUST import them from `shared/types/`.

### Import Path Update Requirements

#### FR-IMPORT-001: Vercel adapter import
`api/hosted/[[...route]].ts` MUST import the hosted app from `hosted/app` and MUST remain free of business logic.

#### FR-IMPORT-002: Local-to-hosted imports
Local code under `back/mcp/`, `back/domains/`, and local guardrail modules MUST NOT import from `hosted/` after the restructure.

#### FR-IMPORT-003: Hosted runtime imports
Hosted code MAY import referenced runtime modules from `back/guardrail/` or `back/intelligence/` only when those modules are required for hosted behavior and do not import local-only MCP or domain entrypoints.

#### FR-IMPORT-004: TypeScript aliases
`tsconfig.json` MUST expose path aliases that resolve `@back/*` to `back/*` and `@shared/*` to `shared/*`. If needed, it MUST add an alias that resolves hosted modules without reintroducing `back/services/hosted` paths.

#### FR-IMPORT-005: No stale paths
No TypeScript source, test, script, or adapter file MAY reference `back/services/hosted/` after the restructure, except historical docs in `docs/hosted-restructure/`.

### Deployment Requirements

#### FR-DEPLOY-001: Vercel bundle boundary
Vercel builds MUST include `hosted/`, `shared/types/`, the thin `api/hosted/` adapter, and any referenced `back/` runtime modules. Vercel builds MUST NOT include local-only MCP server or domain entrypoints through hosted imports.

#### FR-DEPLOY-002: Hosted Bun server
The local hosted backend MUST run through the moved `hosted/server.ts` entrypoint. Package scripts that start the hosted server MUST target the new path.

#### FR-DEPLOY-003: Existing HTTP API surface
The hosted deployment MUST expose the same routes, methods, request formats, response formats, status codes, and policy decisions as before the move.

### Test Preservation Requirements

#### FR-TEST-001: Existing assertions
Existing tests MUST pass without weakening, deleting, or rewriting assertions to hide behavior changes.

#### FR-TEST-002: Moved test imports
Tests moved with hosted modules MUST update imports to the new locations and MUST continue testing the same behavior.

#### FR-TEST-003: Full suite
`npm run test` and `npm run test:back` MUST pass after the restructure.

#### FR-TEST-004: Build check
The project build MUST pass after import updates. If Vercel local tooling is available, `vercel build` SHOULD pass.

## 4. Scenarios

### Scenario: Hosted deployment bundles only allowed boundaries
- GIVEN the hosted backend has been moved to `hosted/`
- WHEN Vercel builds `api/hosted/[[...route]].ts`
- THEN the bundle resolves `hosted/`, `shared/types/`, and referenced `back/` runtime modules
- AND it does not include `back/mcp/` or `back/domains/` through hosted imports

### Scenario: Local MCP server uses shared contracts
- GIVEN the local MCP server needs hosted evaluation or LLM contract types
- WHEN TypeScript resolves its imports
- THEN the imports come from `shared/types/`
- AND no MCP file imports from `hosted/`

### Scenario: Import path aliases resolve
- GIVEN `tsconfig.json` is loaded by TypeScript and Vitest
- WHEN code imports `@back/*` or `@shared/*`
- THEN the aliases resolve to `back/*` and `shared/*`
- AND no code requires the old `back/services/hosted` path

### Scenario: Tests pass after restructure
- GIVEN all file moves and import updates are complete
- WHEN `npm run test` and `npm run test:back` are executed
- THEN all existing tests pass
- AND hosted response assertions remain unchanged

### Scenario: Rollback is clean
- GIVEN the restructure is committed as file moves plus import updates
- WHEN the commit is reverted with Git
- THEN the previous `back/services/hosted/` layout is restored
- AND no database migration, data migration, or external configuration rollback is required

## 5. Non-Functional Requirements

- **NFR-001: No runtime behavior changes.** The restructure MUST NOT change hosted endpoint behavior, guardrail policy decisions, audit payloads, evaluation output, authentication behavior, or error handling.
- **NFR-002: Same HTTP responses.** For equivalent requests, hosted endpoints MUST return the same status codes and response bodies as before the restructure.
- **NFR-003: Clear deployment boundary.** A developer MUST be able to identify deployable hosted code by inspecting the top-level `hosted/` directory.
- **NFR-004: Minimal change surface.** The implementation SHOULD be limited to file moves, contract extraction, import updates, script/config path updates, and tests needed to preserve existing behavior.
- **NFR-005: Type-only shared layer.** `shared/types/` MUST remain free of runtime side effects to prevent hidden coupling between hosted and local systems.
