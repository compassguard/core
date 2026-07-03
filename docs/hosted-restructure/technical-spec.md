# Technical Spec: Hosted Backend Restructure

## 1. Technical Approach

Move `back/services/hosted/` to top-level `hosted/`, extract shared contract types to `shared/types/`, flatten local runtime from `back/services/guardrail/` and `back/services/intelligence/` to `back/guardrail/` and `back/intelligence/`, and update all import paths + config. The restructure is a pure file-move + import-rewrite — no behavior changes.

Key constraint: contract files (`*Contracts.ts`) that contain **runtime functions** (validators, constants with side-effect-free logic) must split. Only type-only exports move to `shared/types/`; runtime validators stay with their module. Three files need splitting: `evaluationContracts.ts`, `auditContracts.ts`, `llmDecisionContracts.ts`.

## 2. Execution Order

Steps are ordered to keep the build green at each stage.

### Phase 1: Create destinations, extract shared types

1. Create `shared/types/` directory
2. Create `hosted/` directory (top-level)
3. Create `back/guardrail/execution/`, `back/guardrail/policy/`, `back/intelligence/llm-router/`
4. Split contract files with runtime code (evaluationContracts, auditContracts, llmDecisionContracts)
5. Move pure-contract files to `shared/types/`
6. Update `tsconfig.json` path aliases

### Phase 2: Move hosted code

7. Move `back/services/hosted/*` → `hosted/*` (preserve directory structure)
8. Move `back/services/guardrail/execution/executionGatewayContracts.ts` → `shared/types/executionGatewayContracts.ts`
9. Move `back/services/guardrail/execution/executionGateway.ts` → `back/guardrail/execution/executionGateway.ts`
10. Move `back/services/guardrail/debugLogger.ts` → `back/guardrail/debugLogger.ts`
11. Move `back/services/guardrail/policy/*` → `back/guardrail/policy/*`
12. Move `back/services/intelligence/llm-router/llmRouterPrompt.ts` → `back/intelligence/llm-router/llmRouterPrompt.ts`

### Phase 3: Update imports globally

13. Update all imports in `hosted/` to use new paths
14. Update all imports in `back/` (mcp, domains, guardrail, intelligence, __tests__)
15. Update `api/hosted/[[...route]].ts`

### Phase 4: Update config & scripts

16. Update `package.json` `hosted:dev` script
17. Update `vitest.back.config.ts` include patterns
18. Update `eslint.config.js` if needed

### Phase 5: Clean up

19. Remove empty `back/services/hosted/`, `back/services/guardrail/`, `back/services/intelligence/` directories
20. Verify build + tests pass

## 3. Path Aliases

```jsonc
// tsconfig.json — updated paths
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@back/*": ["back/*"],
      "@shared/*": ["shared/*"],
      "@hosted/*": ["hosted/*"]
    }
  }
}
```

**Three aliases cover all cases:**

| Alias | Resolves to | Use for |
|-------|------------|---------|
| `@back/*` | `back/*` | Local runtime: guardrail, mcp, domains, intelligence |
| `@shared/*` | `shared/*` | Pure type contracts consumed by both hosted and local |
| `@hosted/*` | `hosted/*` | Hosted-only code; local MUST NOT import from here |

**Relative imports remain valid** within the same subtree (e.g., `hosted/evaluate/evaluationService.ts` → `./evaluationContracts`). Cross-boundary imports MUST use aliases.

## 4. Import Update Strategy

### 4.1 Contract file splits

Three contract files contain runtime functions alongside types. They must split:

**`evaluationContracts.ts`** → split into:
- `shared/types/evaluationContracts.ts` — all type exports (`HostedDecision`, `HostedRiskLevel`, `EvaluateActionRequest`, `EvaluateActionResponse`, `EvaluationService`, `EvaluationServiceDependencies`, `LocalFinding`, `AuditEntry`, etc.) + constants (`HOSTED_DECISIONS`, `HOSTED_RISK_LEVELS`, `LOCAL_FINDING_SEVERITIES`, `AUDIT_ENTRY_OUTCOMES`)
- `hosted/evaluate/evaluationValidators.ts` — runtime validators (`isHostedDecision`, `isHostedRiskLevel`, `validateEvaluateActionRequest`, helper `isRecord`, `isNonEmptyString`, `isLocalFindingSeverity`)

**`auditContracts.ts`** → split into:
- `shared/types/auditContracts.ts` — all type exports + constants (`DEFAULT_AUDIT_QUERY_LIMIT`, `MAX_AUDIT_QUERY_LIMIT`)
- `hosted/audit/auditValidators.ts` — runtime validators (`validateAuditWriteRequest`, `validateAuditQueryParams`, `normalizeAuditQueryLimit`, helper `isRecord`, `isNonEmptyString`)

**`llmDecisionContracts.ts`** → this file is pure types + constants (`LLM_GUARD_DECISIONS`, `LLM_DECISION_STRICTNESS`, `LLM_REDACTED`, etc.) with no side effects. Per project convention ("types, interfaces, enums, and Zod schemas"), constants used as enums are acceptable in shared. **No split needed** — move entire file to `shared/types/llmDecisionContracts.ts`.

**`policyContracts.ts`** — pure types + constants (`POLICY_OUTCOMES`, `POLICY_REASON_CODES`). **No split needed** — move to `shared/types/policyContracts.ts`.

**`executionGatewayContracts.ts`** — pure types + constants (`COMPASS_DECISIONS`, `TOOL_RISK_CLASSES`). **No split needed** — move to `shared/types/executionGatewayContracts.ts`.

**`llmRouterContracts.ts`** — pure types + constants (`LLM_ROUTER_ENV`, `LLM_ROUTER_DEFAULTS`). **No split needed** — move to `shared/types/llmRouterContracts.ts`.

**`hostedAuthMiddlewareContracts.ts`** and **`hostedErrorMiddlewareContracts.ts`** — pure types. Move entire files to `shared/types/`.

### 4.2 Cross-boundary import rules

| From | To allowed | To forbidden |
|------|-----------|-------------|
| `hosted/*` | `@shared/*`, `@back/*`, `./relative` | Direct `back/services/*` paths |
| `back/mcp/*` | `@shared/*`, `@back/*`, `./relative` | `@hosted/*` |
| `back/domains/*` | `@shared/*`, `@back/*`, `./relative` | `@hosted/*` |
| `shared/types/*` | `./relative` only | Everything else (no deps) |
| `api/hosted/*` | `@hosted/*`, `@shared/*` | `@back/*` |

### 4.3 Specific import replacements

Full list of files that need import changes, grouped by change type:

**Files moving to `hosted/`** — update relative `../../guardrail/` paths:

| File | Old import path | New import path |
|------|----------------|----------------|
| `hosted/policy/policyContracts.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `hosted/policy/loadPolicy.ts` | `../../guardrail/policy/policySchema` | `@back/guardrail/policy/policySchema` |
| `hosted/policy/policyEngine.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `hosted/policy/policyEngine.ts` | `../../guardrail/debugLogger` | `@back/guardrail/debugLogger` |
| `hosted/policy/policyEngine.ts` | `../../guardrail/policy/policyEvaluationResult` | `@back/guardrail/policy/policyEvaluationResult` |
| `hosted/evaluate/evaluationService.ts` | `../../guardrail/execution/executionGateway` | `@back/guardrail/execution/executionGateway` |
| `hosted/evaluate/evaluationService.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `hosted/llm/llmDecisionContracts.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `hosted/llm/llmDecisionAdapter.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `hosted/llm/llmDecisionSanitizer.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |

**Files moving to `back/guardrail/`** — update `../../hosted/` paths:

| File | Old import path | New import path |
|------|----------------|----------------|
| `back/guardrail/policy/policyEvaluationResult.ts` | `../../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `back/guardrail/policy/policyEvaluationResult.ts` | `../execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `back/guardrail/policy/policySchema.ts` | `../../hosted/policy/policyContracts` | `@shared/policyContracts` |

**`back/services/mcp/`** — update `../../hosted/` paths:

| File | Old import path | New import path |
|------|----------------|----------------|
| `mcp/proxy/mcpHostedClient.ts` | `../../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |
| `mcp/proxy/mcpProxyDispatcher.ts` | `../../hosted/llm/llmDecisionAdapter` | `@hosted/llm/llmDecisionAdapter` ✗ |
| `mcp/proxy/mcpProxyDispatcher.ts` | `../../hosted/llm/llmRouterAdapter` | `@hosted/llm/llmRouterAdapter` ✗ |
| `mcp/proxy/mcpProxyDispatcher.ts` | `../../hosted/llm/llmRouterContracts` | `@shared/llmRouterContracts` |
| `mcp/proxy/mcpProxyDispatcher.ts` | `../../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |
| `mcp/proxy/mcpProxyContracts.ts` | `../../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |
| `mcp/proxy/mcpEvaluationRequest.ts` | `../../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |
| `mcp/proxy/mcpHostedClientContracts.ts` | `../../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |

> **⚠️ Open question**: `mcpProxyDispatcher.ts` imports runtime adapters (`llmDecisionAdapter`, `llmRouterAdapter`) from hosted. The rule says local MUST NOT import from hosted. Two options: (A) extract adapter interfaces to shared, keep implementations in hosted, inject via dependency injection; (B) move adapters to `back/guardrail/` or a shared runtime location. Option (A) is cleaner but larger change. Decision needed before Phase 3.

**`back/services/domains/`** — update `../../hosted/` paths:

| File | Old import path | New import path |
|------|----------------|----------------|
| `domains/transfer/transferGateway.ts` | `../../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` ✗ |
| `domains/transfer/transferGateway.ts` | `../../hosted/policy/policyEngine` | `@hosted/policy/policyEngine` ✗ |
| `domains/transfer/transferGatewayContracts.ts` | `../../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `domains/transfer/transferGatewayContracts.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `domains/swap/swapGateway.ts` | `../../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` ✗ |
| `domains/swap/swapGateway.ts` | `../../hosted/policy/policyEngine` | `@hosted/policy/policyEngine` ✗ |
| `domains/swap/swapGatewayContracts.ts` | `../../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `domains/swap/swapGatewayContracts.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `domains/conditional-parking-lot/conditionalGateway.ts` | `../../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` ✗ |
| `domains/conditional-parking-lot/conditionalGateway.ts` | `../../hosted/policy/policyEngine` | `@hosted/policy/policyEngine` ✗ |
| `domains/conditional-parking-lot/conditionalGatewayContracts.ts` | `../../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `domains/conditional-parking-lot/conditionalGatewayContracts.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |

> **⚠️ Open question**: Domain gateways import runtime code (`loadPolicy`, `policyEngine`) from hosted policy. Same issue as MCP above. These need to move to `back/guardrail/policy/` or be injected.

**Test files (`back/services/__tests__/`)** — update `../hosted/` paths:

| File | Old import path | New import path |
|------|----------------|----------------|
| `hybrid-e2e.test.ts` | `../hosted/app` | `@hosted/app` |
| `hybrid-e2e.test.ts` | `../hosted/audit/auditStore` | `@hosted/audit/auditStore` |
| `hybrid-e2e.test.ts` | `../hosted/audit/auditContracts` (type) | `@shared/auditContracts` |
| `hybrid-e2e.test.ts` | `../hosted/evaluate/evaluationContracts` (type) | `@shared/evaluationContracts` |
| `hybridContracts.test.ts` | `../hosted/evaluate/evaluationContracts` | `@shared/evaluationContracts` |
| `hybridContracts.test.ts` | `../hosted/audit/auditContracts` | `@shared/auditContracts` |
| `hybridContracts.test.ts` | `../hosted/policies/policyContracts` | `@shared/policyContracts` |
| `transferGateway.test.ts` | `../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` |
| `transferGateway.test.ts` | `../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `swapGateway.test.ts` | `../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` |
| `swapGateway.test.ts` | `../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `conditionalGateway.test.ts` | `../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` |
| `conditionalGateway.test.ts` | `../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `policyEngine.test.ts` | `../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` |
| `policyEngine.test.ts` | `../hosted/policy/policyEngine` | `@hosted/policy/policyEngine` |
| `policyEngine.test.ts` | `../hosted/policy/policyContracts` | `@shared/policyContracts` |
| `llmDecisionAdapter.test.ts` | `../hosted/llm/llmDecisionContracts` | `@shared/llmDecisionContracts` |
| `llmDecisionAdapter.test.ts` | `../hosted/llm/llmDecisionAdapter` | `@hosted/llm/llmDecisionAdapter` |
| `llmDecisionSanitizer.test.ts` | `../hosted/llm/llmDecisionContracts` | `@shared/llmDecisionContracts` |
| `llmDecisionSanitizer.test.ts` | `../hosted/llm/llmDecisionSanitizer` | `@hosted/llm/llmDecisionSanitizer` |
| `llmRouterAdapter.test.ts` | `../hosted/llm/llmRouterContracts` | `@shared/llmRouterContracts` |
| `llmRouterAdapter.test.ts` | `../hosted/llm/llmRouterAdapter` | `@hosted/llm/llmRouterAdapter` |
| `mcpProxyLlmDecisionIntegration.test.ts` | `../hosted/llm/llmDecisionAdapter` (type) | `@hosted/llm/llmDecisionAdapter` |
| `loadPolicy.test.ts` | `../hosted/policy/loadPolicy` | `@hosted/policy/loadPolicy` |
| `executionGateway.test.ts` | `../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |
| `evaluationService.test.ts` | `../../guardrail/execution/executionGatewayContracts` | `@shared/executionGatewayContracts` |

**`api/hosted/[[...route]].ts`**:

| Old | New |
|-----|-----|
| `../../back/services/hosted/app` | `@hosted/app` |

### 4.4 Runtime dependency: `loadPolicy` and `policyEngine`

Two hosted files are runtime code imported by local domains:

- `hosted/policy/loadPolicy.ts` — calls `validateCompassPolicy` from `back/guardrail/policy/policySchema`
- `hosted/policy/policyEngine.ts` — calls `debug` from `back/guardrail/debugLogger`, uses `executionGatewayContracts`, `policyEvaluationResult`

**Decision: Leave `loadPolicy.ts`, `policyEngine.ts`, and `defaultPolicy.ts` in `hosted/policy/`.** Local domain gateways that need policy evaluation should import from `@hosted/policy/loadPolicy` and `@hosted/policy/policyEngine`. This is acceptable because:

1. The domain gateways (`transferGateway`, `swapGateway`, `conditionalGateway`) already live in `back/services/domains/` alongside the MCP server — they're part of the local runtime, not a separate deployment.
2. The domain gateways call hosted policy code at runtime via the local process, not via HTTP. Moving `policyEngine` to `back/guardrail/` would force hosted to depend on `back/`, creating the reverse coupling.
3. The alternative (extracting interfaces + DI) is a larger change outside restructure scope.

Scoping note: domain gateways importing from `@hosted/` is a known dependency direction issue. A future change can extract a policy evaluation interface into `shared/types/` and inject implementations, but this is out of scope for the restructure.

## 5. File Structure

```
compass/
├── api/
│   └── hosted/
│       └── [[...route]].ts           ← update import to @hosted/app
├── hosted/                           ← NEW top-level (was back/services/hosted/)
│   ├── app.ts
│   ├── appContracts.ts
│   ├── server.ts
│   ├── serverContracts.ts
│   ├── app.test.ts
│   ├── audit/
│   │   ├── auditContracts.ts         ← local-only (imports from shared)
│   │   ├── auditRoutes.ts
│   │   ├── auditStore.ts
│   │   └── auditValidators.ts        ← NEW (split from auditContracts)
│   ├── evaluate/
│   │   ├── evaluationContracts.ts    ← local re-exports from shared
│   │   ├── evaluationRoutes.ts
│   │   ├── evaluationService.ts
│   │   ├── evaluationService.test.ts
│   │   └── evaluationValidators.ts   ← NEW (split from evaluationContracts)
│   ├── health/
│   │   ├── healthContracts.ts
│   │   └── healthRoutes.ts
│   ├── http/
│   │   ├── hostedAuthMiddleware.ts
│   │   ├── hostedAuthMiddleware.test.ts
│   │   ├── hostedAuthMiddlewareContracts.ts  ← stays (local import)
│   │   ├── hostedErrorMiddleware.ts
│   │   └── hostedErrorMiddlewareContracts.ts ← stays (local import)
│   ├── llm/
│   │   ├── llmDecisionAdapter.ts
│   │   ├── llmDecisionSanitizer.ts
│   │   └── llmRouterAdapter.ts
│   ├── policies/
│   │   ├── policyContracts.ts        ← local re-exports from shared
│   │   ├── policyRoutes.ts
│   │   └── policyService.ts
│   └── policy/
│       ├── defaultPolicy.ts
│       ├── loadPolicy.ts
│       └── policyEngine.ts
├── shared/
│   ├── README.md                     ← update to reflect types/ content
│   └── types/
│       ├── executionGatewayContracts.ts  ← was back/services/guardrail/execution/
│       ├── policyContracts.ts            ← was hosted/policy/policyContracts
│       ├── evaluationContracts.ts        ← was hosted/evaluate/evaluationContracts (types+constants only)
│       ├── llmDecisionContracts.ts       ← was hosted/llm/llmDecisionContracts
│       ├── llmRouterContracts.ts          ← was hosted/llm/llmRouterContracts
│       ├── hostedAuthMiddlewareContracts.ts
│       └── hostedErrorMiddlewareContracts.ts
├── back/
│   ├── guardrail/
│   │   ├── debugLogger.ts                ← was back/services/guardrail/
│   │   ├── execution/
│   │   │   └── executionGateway.ts       ← was back/services/guardrail/execution/
│   │   └── policy/
│   │       ├── policyEvaluationResult.ts  ← was back/services/guardrail/policy/
│   │       └── policySchema.ts             ← was back/services/guardrail/policy/
│   ├── intelligence/
│   │   └── llm-router/
│   │       └── llmRouterPrompt.ts        ← was back/services/intelligence/llm-router/
│   ├── services/
│   │   ├── mcp/                          ← stays
│   │   ├── domains/                      ← stays
│   │   ├── __tests__/                    ← stays (imports update)
│   │   └── ...                           ← stays (other local code)
│   └── ...
└── ...config files
```

**Note on `hosted/` contract re-export files**: Files like `hosted/evaluate/evaluationContracts.ts`, `hosted/audit/auditContracts.ts`, and `hosted/policies/policyContracts.ts` currently contain both types and runtime validators. After the split, these local files will re-export from `@shared/` for convenience:

```ts
// hosted/evaluate/evaluationContracts.ts (after split)
export type {
  HostedDecision, HostedRiskLevel, // ...
} from "@shared/evaluationContracts";
export {
  HOSTED_DECISIONS, HOSTED_RISK_LEVELS, // ...
} from "@shared/evaluationContracts";
export { isHostedDecision, isHostedRiskLevel } from "./evaluationValidators";
export { validateEvaluateActionRequest } from "./evaluationValidators";
```

## 6. Vercel Configuration

`vercel.json` needs no changes — rewrites already point to `/api/hosted/...`. The adapter at `api/hosted/[[...route]].ts` imports from `@hosted/app`, which will resolve correctly with the tsconfig alias.

**Build check**: Vercel's Node builder resolves `tsconfig.json` path aliases. Verify by running:

```bash
npx tsc --noEmit
```

If Vercel fails to resolve `@hosted/*` or `@shared/*`, add an explicit `include` for those directories in `tsconfig.json` (already covered by `"include": ["**/*.ts"]`).

No `vercel.json` changes required.

## 7. Test Configuration

```ts
// vitest.back.config.ts — updated
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@back': path.resolve(__dirname, 'back'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@hosted': path.resolve(__dirname, 'hosted'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'back/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'hosted/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: ['node_modules/**', '.next/**'],
  },
});
```

Changes:
- Add `resolve.alias` block mapping `@back`, `@shared`, `@hosted` to filesystem paths (Vitest doesn't read tsconfig `paths` by default)
- Expand `include` to cover `hosted/**/*.test.ts` (moved out of `back/services/`)
- `back/**` pattern still covers `back/services/__tests__/` and `back/guardrail/`

## 8. Migration Steps

```bash
# Phase 1: Create directories
mkdir -p shared/types
mkdir -p hosted
mkdir -p back/guardrail/execution
mkdir -p back/guardrail/policy
mkdir -p back/intelligence/llm-router

# Phase 2: Move contract files to shared/types/
git mv back/services/guardrail/execution/executionGatewayContracts.ts shared/types/executionGatewayContracts.ts
git mv back/services/hosted/policy/policyContracts.ts shared/types/policyContracts.ts
git mv back/services/hosted/evaluate/evaluationContracts.ts shared/types/evaluationContracts.ts
git mv back/services/hosted/llm/llmDecisionContracts.ts shared/types/llmDecisionContracts.ts
git mv back/services/hosted/llm/llmRouterContracts.ts shared/types/llmRouterContracts.ts
git mv back/services/hosted/http/hostedAuthMiddlewareContracts.ts shared/types/hostedAuthMiddlewareContracts.ts
git mv back/services/hosted/http/hostedErrorMiddlewareContracts.ts shared/types/hostedErrorMiddlewareContracts.ts

# Phase 3: Split evaluationContracts.ts (manual edit)
# - Create shared/types/evaluationContracts.ts with types + constants
# - Create hosted/evaluate/evaluationValidators.ts with runtime validators
# - Create hosted/evaluate/evaluationContracts.ts as re-export barrel

# Phase 4: Split auditContracts.ts (manual edit)
# - Create hosted/audit/auditValidators.ts with runtime validators
# - Update hosted/audit/auditContracts.ts as re-export barrel

# Phase 5: Move hosted directory
git mv back/services/hosted/app.ts hosted/app.ts
git mv back/services/hosted/appContracts.ts hosted/appContracts.ts
git mv back/services/hosted/server.ts hosted/server.ts
git mv back/services/hosted/serverContracts.ts hosted/serverContracts.ts
git mv back/services/hosted/app.test.ts hosted/app.test.ts
git mv back/services/hosted/audit hosted/audit
git mv back/services/hosted/evaluate hosted/evaluate
git mv back/services/hosted/health hosted/health
git mv back/services/hosted/http hosted/http
git mv back/services/hosted/llm hosted/llm
git mv back/services/hosted/policies hosted/policies
git mv back/services/hosted/policy hosted/policy

# Phase 6: Move guardrail runtime
git mv back/services/guardrail/execution/executionGateway.ts back/guardrail/execution/executionGateway.ts
git mv back/services/guardrail/debugLogger.ts back/guardrail/debugLogger.ts
git mv back/services/guardrail/policy/policyEvaluationResult.ts back/guardrail/policy/policyEvaluationResult.ts
git mv back/services/guardrail/policy/policySchema.ts back/guardrail/policy/policySchema.ts

# Phase 7: Move intelligence runtime
git mv back/services/intelligence/llm-router/llmRouterPrompt.ts back/intelligence/llm-router/llmRouterPrompt.ts

# Phase 8: Update all imports (see Section 4.3 for full list)
# Use IDE find-replace or codemod. Key patterns:
#   "../../guardrail/execution/executionGatewayContracts" → "@shared/executionGatewayContracts"
#   "../../guardrail/execution/executionGateway" → "@back/guardrail/execution/executionGateway"
#   "../../guardrail/debugLogger" → "@back/guardrail/debugLogger"
#   "../../guardrail/policy/policySchema" → "@back/guardrail/policy/policySchema"
#   "../../guardrail/policy/policyEvaluationResult" → "@back/guardrail/policy/policyEvaluationResult"
#   "../../hosted/evaluate/evaluationContracts" → "@shared/evaluationContracts"
#   "../../hosted/llm/llmDecisionContracts" → "@shared/llmDecisionContracts"
#   "../../hosted/llm/llmRouterContracts" → "@shared/llmRouterContracts"
#   "../../hosted/policy/policyContracts" → "@shared/policyContracts"
#   "../../guardrail/execution/executionGatewayContracts" → "@shared/executionGatewayContracts"
#   "../../back/services/hosted/app" → "@hosted/app"

# Phase 9: Update config files (see Sections 3, 7)
# - tsconfig.json: add @hosted/* alias
# - vitest.back.config.ts: add resolve.alias + expand include
# - package.json: update hosted:dev script

# Phase 10: Clean up empty directories
rm -rf back/services/hosted
rm -rf back/services/guardrail  # if fully emptied
rm -rf back/services/intelligence  # if fully emptied
```

### package.json script change

```jsonc
// Before
"hosted:dev": "bun back/services/hosted/server.ts"

// After
"hosted:dev": "bun hosted/server.ts"
```

## 9. Rollback Procedure

Since all changes are file moves + import rewrites (no data migration, no config outside the repo):

1. `git revert HEAD` — single commit rollback
2. All `git mv` operations are tracked as renames; revert restores original paths
3. Remove `shared/types/` directory if reverting before shared types existed
4. No external state, no database changes, no deployment dependency

If only part of the migration completed:
```bash
# Reset to last known-good commit
git reset --hard <last-good-sha>
# Or stage-by-stage revert
git checkout <last-good-sha> -- back/services/hosted/ shared/ hosted/ back/guardrail/
```

## 10. Verification Steps

Run after each phase:

**After Phase 1–2 (file moves, before import updates):**
```bash
# Verify files exist at new locations
ls shared/types/executionGatewayContracts.ts
ls hosted/app.ts
ls back/guardrail/execution/executionGateway.ts
ls back/intelligence/llm-router/llmRouterPrompt.ts
```

**After Phase 3 (import updates):**
```bash
# TypeScript compilation — must pass with zero errors
npx tsc --noEmit

# Grep for stale paths — must return zero results
grep -r "back/services/hosted" --include="*.ts" --exclude-dir=docs .
grep -r "../../guardrail/execution/executionGatewayContracts" --include="*.ts" .
grep -r "../../guardrail/debugLogger" --include="*.ts" .
grep -r "../../hosted/" --include="*.ts" .

# Check forbidden import direction: back/ must not import from hosted/
# (excluding known domain gateway policy imports — see Section 4.4)
grep -rn "from.*@hosted" back/services/mcp/ --include="*.ts"
grep -rn "from.*@hosted" back/services/domains/ --include="*.ts" | grep -v "policy/" | grep -v "loadPolicy"
```

**After Phase 4 (config updates):**
```bash
# Run full test suite
npm run test:back

# Verify test discovery covers new locations
npx vitest --config vitest.back.config.ts --run 2>&1 | head -30
# Should show test files from both back/ and hosted/

# Verify hosted dev server starts
bun hosted/server.ts &
# curl http://localhost:3001/health
# kill %1
```

**After Phase 5 (cleanup):**
```bash
# Final TypeScript check
npx tsc --noEmit

# Final test pass
npm run test:back

# Verify no empty directories remain
ls back/services/hosted 2>&1  # should fail: directory not found
ls back/services/guardrail 2>&1  # should fail: directory not found

# Verify Vercel build (if vercel CLI available)
npx vercel build --prod 2>&1 | tail -10
```