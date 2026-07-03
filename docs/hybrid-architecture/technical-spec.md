# Hybrid Architecture Technical Spec

## 1. Technical Approach

Compass will split the current Wave 11 local MCP proxy into two deployable boundaries:

- **Local proxy**: keeps the MCP stdio surface in `back/services/mcp/server/mcpServer.ts`, normalizes `tools/call`, runs deterministic local checks, calls the hosted HTTP API with a short timeout, and fails closed on uncertainty.
- **Hosted backend**: runs as a Hono app on Bun/Vercel and owns risk evaluation, policy evaluation, durable audit, and optional LLM evaluation.

The local process remains the only MCP server exposed to agents. Hosted services never execute or sign tool calls; they only return `allow`, `deny`, or `confirm`. The proxy enforces that decision before invoking any execution path. No policy cache is introduced in this change.

## 2. Architecture Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| MCP boundary | Keep `back/services/mcp/server/mcpServer.ts` as the stdio entrypoint | Preserves agent compatibility and keeps Compass as the enforcement boundary. |
| Downstream MCP | Retire required downstream stdio forwarding for guarded operations | The proposal removes downstream MCP as the source of active behavior; Compass should own guarded execution paths. |
| Local checks | Keep deterministic classifier logic local in a refactored interceptor | Fast local denies avoid network latency and protect against hosted outages. |
| Hosted app | Add Hono handlers under `back/services/hosted/` | Small HTTP surface, Bun-compatible, and deployable to Vercel with low ceremony. |
| HTTP client | Use native `fetch` plus `AbortController` | Already available, no dependency needed. |
| Contracts | Put request/response types in dedicated `*Contracts.ts` files | Matches the project type convention and avoids mixing schemas with behavior. |
| Audit | Hosted audit is authoritative; local audit becomes diagnostics only | Functional spec requires durable persistence and audit references before allow. |
| Policy cache | Do not cache hosted policy locally | Explicitly deferred to a separate proposal. |

## 3. Data Flow

```text
AI agent / MCP client
        |
        | MCP stdio tools/call
        v
Local Compass MCP proxy
        |
        | normalize + correlationId
        v
┌─────────────────────────────────────┐
│ LOCAL DETERMINISTIC CHECKS          │
│                                     │
│  mcpProxyPolicyInterceptor          │
│  (heuristic: tokenize toolName)     │
│                                     │
│  read_only / ui_bootstrap /         │
│  preparation_simulation → ALLOW     │
│  sensitive_execution / signing      │
│  → DENY (never hits hosted)         │
│  routable_mutation / unknown        │
│  → require_approval (continues)     │
└──────────────┬──────────────────────┘
               |
               | require_approval
               v
┌─────────────────────────────────────┐
│ HOSTED BACKEND (POST /v1/evaluate)  │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ LLM Router (REUSED)         │    │
│  │ llmRouterAdapter.ts         │    │
│  │ Clasifica: transfer/swap/   │    │
│  │ skip/unknown                │    │
│  └──────────┬──────────────────┘    │
│             |                       │
│     skip → ALLOW                    │
│     unknown → DENY (fail-closed)    │
│     transfer/swap ↓                 │
│  ┌─────────────────────────────┐    │
│  │ Policy Engine (REUSED)      │    │
│  │ policyEngine.ts             │    │
│  │ evaluateAction()            │    │
│  │ Reglas por actionKind       │    │
│  └──────────┬──────────────────┘    │
│             |                       │
│  ┌─────────────────────────────┐    │
│  │ LLM Decision Judge (REUSED) │    │
│  │ llmDecisionAdapter.ts       │    │
│  │ Juez asesor con clamp       │    │
│  │ Puede cambiar/afianzar      │    │
│  │ la decisión del policy      │    │
│  └──────────┬──────────────────┘    │
│             |                       │
│             v                       │
│  Audit persistence + decision       │
└──────────────┬──────────────────────┘
               |
               v
        allow | deny | confirm
               |
               v
Local proxy enforces decision, executes only on allow.
```

## 4. Component Design

### Reusable Components (moved to hosted, not rewritten)

| Component | Current Location | Action | Notes |
| --- | --- | --- | --- |
| `llmRouterAdapter.ts` | `intelligence/llm-router/` | Move to hosted | Already makes HTTP calls to external providers. No changes needed. |
| `llmDecisionAdapter.ts` | `intelligence/llm-decision/` | Move to hosted | Already makes HTTP calls. Decision clamp logic stays intact. |
| `llmRouterContracts.ts` | `intelligence/llm-router/` | Move to hosted | Types for router classification. |
| `llmDecisionContracts.ts` | `intelligence/llm-decision/` | Move to hosted | Types for decision judge, strictness mapping. |
| `llmDecisionSanitizer.ts` | `intelligence/llm-decision/` | Move to hosted | Redacts sensitive data before LLM calls. |
| `policyEngine.ts` | `guardrail/policy/` | Move to hosted | Pure function, no side effects. Evaluates actions by actionKind. |
| `policyContracts.ts` | `guardrail/policy/` | Move to hosted | Policy type system, reason codes. |
| `defaultPolicy.ts` | `guardrail/policy/` | Move to hosted | Hardcoded default policy values. |
| `loadPolicy.ts` | `guardrail/policy/` | Move to hosted | Policy loading and caching. |
| `executionGateway.ts` | `guardrail/execution/` | Keep local + hosted | classifyToolCall() stays local for fast denies. createActionCandidate() and buildAuditEvent() move to hosted. |

### Local Components (stay local)

| Component | Current Location | Action | Notes |
| --- | --- | --- | --- |
| `mcpProxyPolicyInterceptor.ts` | `mcp/proxy/` | Keep local | Heuristic classifier. Tokenizes toolName, returns ProxyRiskClass. Fast local deny for read_only, signing, sensitive_execution. |
| `mcpServer.ts` | `mcp/server/` | Keep local | MCP stdio entrypoint. |
| `mcpProxyDispatcher.ts` | `mcp/proxy/` | Refactor | Remove LLM/policy/audit orchestration. Add hosted HTTP client call. |
| `mcpHostedClient.ts` | (new) | Create | Local HTTP client for hosted API. |
| `mcpEvaluationRequest.ts` | (new) | Create | Builds normalized evaluation requests. |

### Local Proxy Refactor

What stays:

- `back/services/mcp/server/mcpServer.ts` remains the stdio server entrypoint.
- `createProxyMcpServerHandlers()` keeps mapping MCP requests to proxy results.
- `mcpProxyPolicyInterceptor.ts` keeps deterministic classification such as read-only, signing, sensitive execution, routable mutation, and unknown.
- Safe non-tool MCP method rejection remains fail-closed.

What changes:

- `createProxyDispatcher()` stops being responsible for hosted-grade policy, LLM routing, and durable audit.
- `callTool()` becomes an evaluation pipeline:

```ts
export async function callTool(args: ProxiedMcpToolCall): Promise<ProxyCallToolResult> {
  const request = buildEvaluateActionRequest(args);
  const localDecision = evaluateLocalToolCallChecks(request);
  if (localDecision.outcome === "deny") return mapDeniedLocalDecision(localDecision);

  const hostedDecision = await hostedClient.evaluateAction(request);
  if (hostedDecision.decision !== "allow") return mapHostedBlock(hostedDecision);

  const result = await executeCompassTool(args);
  return mapAllowedResult(result, hostedDecision.auditRef);
}
```

- Local env config adds:
  - `COMPASS_HOSTED_API_URL`
  - `COMPASS_HOSTED_API_KEY`
  - `COMPASS_HOSTED_TIMEOUT_MS`, default `750`
- `mcpProxyAudit.ts` is kept only for local diagnostics/tests or retired after hosted audit integration.
- `downstreamMcpStdioClient.ts` and `mcpConfigWrapping.ts` are retired from the guarded happy path. If kept temporarily, they must be test-only or legacy adapter code, not the primary execution route.

### Hosted Backend

New hosted service structure:

```text
back/services/hosted/
  app.ts
  server.ts
  http/hostedAuthMiddleware.ts
  http/hostedErrorMiddleware.ts
  evaluate/evaluationRoutes.ts
  evaluate/evaluationService.ts
  evaluate/evaluationContracts.ts
  audit/auditRoutes.ts
  audit/auditStore.ts
  audit/auditContracts.ts
  policies/policyRoutes.ts
  policies/policyService.ts
  policies/policyContracts.ts
  health/healthRoutes.ts
```

Route registration:

```ts
export function createHostedApp(deps: HostedAppDependencies): Hono {
  const app = new Hono();
  app.use("/v1/*", hostedAuthMiddleware(deps.auth));
  app.route("/health", createHealthRoutes(deps.health));
  app.route("/v1", createEvaluationRoutes(deps.evaluations));
  app.route("/v1", createAuditRoutes(deps.audit));
  app.route("/v1", createPolicyRoutes(deps.policies));
  return app;
}
```

Hosted services reuse current business logic:

- `policyEngine.ts` moves to hosted as the policy evaluator (pure function, no changes).
- `executionGateway.ts` splits: `classifyToolCall()` stays local, `createActionCandidate()` and `buildAuditEvent()` move to hosted.
- `llmRouterAdapter.ts` and `llmDecisionAdapter.ts` move to hosted and are called by the evaluation service, not directly by the local proxy.

### HTTP API Contract

Core types live in `back/services/hosted/evaluations/evaluationContracts.ts` and are imported by both local client and hosted routes.

```ts
export type HostedDecision = "allow" | "deny" | "confirm";
export type HostedRiskLevel = "low" | "medium" | "high" | "unknown";

export type EvaluateActionRequest = {
  correlationId: string;
  idempotencyKey: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  agentContext?: {
    clientName?: string;
    userIntent?: string;
    sessionId?: string;
  };
  localFindings: Array<{
    code: string;
    severity: "info" | "warn" | "block";
    message: string;
  }>;
  requestedAt: string;
};

export type EvaluateActionResponse = {
  correlationId: string;
  decision: HostedDecision;
  riskLevel: HostedRiskLevel;
  reasons: string[];
  suggestedAction?: string;
  auditRef: string;
};

export type AuditEntry = {
  correlationId: string;
  auditRef: string;
  toolName: string;
  decision: HostedDecision;
  riskLevel: HostedRiskLevel;
  reasons: string[];
  outcome?: "success" | "failure";
  occurredAt: string;
};

export type PolicySnapshot = {
  version: string;
  updatedAt: string;
  rules: Record<string, unknown>;
};
```

Response validation is strict in the local client. Missing `decision`, malformed `riskLevel`, or missing `auditRef` becomes a local fail-closed denial.

### Error Handling

- Local deterministic block: return MCP tool error immediately and do not call hosted APIs.
- Hosted timeout: abort with `AbortController`; high-risk and unknown-risk calls fail closed.
- Hosted `401`, `403`, `5xx`, network errors, invalid JSON, or malformed contract: fail closed.
- Hosted audit failure before decision persistence: hosted returns `deny` with `audit-degraded-denial`; local does not execute.
- Execution outcome audit failure after execution: local retries once with the same `idempotencyKey`; failure is logged locally but cannot undo execution.

Operator-facing failure reason format:

```json
{
  "ok": false,
  "decision": "deny",
  "reason": "Hosted evaluation timed out after 750ms; denying fail-closed.",
  "suggestedAction": "Check COMPASS_HOSTED_API_URL, credentials, and hosted health before retrying."
}
```

## 5. File Structure

### Files to Create

| File | Action | Description |
| --- | --- | --- |
| `back/services/mcp/proxy/mcpHostedClient.ts` | Create | Local HTTP client using `fetch`, auth header, timeout, and response validation. |
| `back/services/mcp/proxy/mcpHostedClientContracts.ts` | Create | Local-hosted client config and error contracts. |
| `back/services/mcp/proxy/mcpEvaluationRequest.ts` | Create | Builds normalized evaluation requests and correlation IDs. |
| `back/services/hosted/app.ts` | Create | Hono app factory. |
| `back/services/hosted/server.ts` | Create | Bun/Vercel entrypoint. |
| `back/services/hosted/evaluate/*` | Create | Action evaluation route, service, contracts. |
| `back/services/hosted/audit/*` | Create | Audit routes, contracts, persistence adapter. |
| `back/services/hosted/policies/*` | Create | Policy routes, service, contracts. |
| `back/services/hosted/health/*` | Create | Health route and dependency checks. |
| `package.json` | Modify | Add `hono`; add scripts such as `hosted:dev` if needed. |
| `vercel.json` | Create | Route hosted API entrypoint if Vercel requires explicit config. |

### Files to Modify

| File | Action | Description |
| --- | --- | --- |
| `back/services/mcp/proxy/mcpProxyDispatcher.ts` | Modify | Replace local LLM/policy/audit orchestration with local checks plus hosted decision enforcement. |
| `back/services/mcp/proxy/mcpProxyContracts.ts` | Modify | Add hosted decision/audit reference fields and remove downstream-only assumptions. |
| `back/services/mcp/server/mcpServer.ts` | Modify | Stop requiring `DownstreamMcpClient` for server construction; inject hosted client and execution dependencies. |

### Files to Move to Hosted (REUSED, not rewritten)

| File | Current Location | New Location | Changes |
| --- | --- | --- | --- |
| `llmRouterAdapter.ts` | `intelligence/llm-router/` | `back/services/hosted/llm/` | None — already makes HTTP calls |
| `llmRouterContracts.ts` | `intelligence/llm-router/` | `back/services/hosted/llm/` | None |
| `llmDecisionAdapter.ts` | `intelligence/llm-decision/` | `back/services/hosted/llm/` | None — already makes HTTP calls |
| `llmDecisionContracts.ts` | `intelligence/llm-decision/` | `back/services/hosted/llm/` | None |
| `llmDecisionSanitizer.ts` | `intelligence/llm-decision/` | `back/services/hosted/llm/` | None |
| `policyEngine.ts` | `guardrail/policy/` | `back/services/hosted/policy/` | None — pure function |
| `policyContracts.ts` | `guardrail/policy/` | `back/services/hosted/policy/` | None |
| `defaultPolicy.ts` | `guardrail/policy/` | `back/services/hosted/policy/` | None |
| `loadPolicy.ts` | `guardrail/policy/` | `back/services/hosted/policy/` | None |

### Files to Retire

| File | Action | Description |
| --- | --- | --- |
| `back/services/mcp/proxy/mcpProxyPolicyInterceptor.ts` | Keep local | Heuristic classifier stays local for fast denies. |
| `back/services/mcp/proxy/mcpProxyAudit.ts` | Retire/Modify | Replace authoritative in-memory audit with hosted audit client; keep test diagnostics if needed. |
| `back/services/mcp/proxy/downstreamMcpStdioClient.ts` | Retire | No longer part of the guarded happy path after downstream MCP removal. |
| `back/services/mcp/proxy/mcpConfigWrapping.ts` | Retire | Config wrapping for downstream stdio is legacy once Compass owns execution. |

## 6. API Contract

### `GET /health`

Returns hosted service health. Unauthenticated.

Response `200`:

```json
{
  "ok": true,
  "service": "compass-hosted-guard",
  "dependencies": {
    "auditStore": "ok",
    "policy": "ok",
    "llm": "degraded"
  }
}
```

### `POST /v1/evaluate`

Main validation endpoint. Evaluates an action and returns decision + audit reference.

Headers:

```http
Authorization: Bearer <COMPASS_HOSTED_API_KEY>
Content-Type: application/json
Idempotency-Key: eval_01h...
```

Request:

```json
{
  "correlationId": "corr_01hxy8",
  "idempotencyKey": "eval_corr_01hxy8",
  "toolName": "transfer_sol",
  "arguments": { "recipient": "7Y...", "amountSol": 0.25 },
  "agentContext": { "clientName": "opencode", "sessionId": "local-session" },
  "localFindings": [
    { "code": "ROUTABLE_MUTATION", "severity": "warn", "message": "Financial mutation requires hosted evaluation." }
  ],
  "requestedAt": "2026-06-17T12:00:00.000Z"
}
```

Response `200`:

```json
{
  "correlationId": "corr_01hxy8",
  "decision": "confirm",
  "riskLevel": "medium",
  "reasons": ["TRANSFER_UNKNOWN_RECIPIENT"],
  "suggestedAction": "Request explicit user confirmation before execution.",
  "auditRef": "aud_01hxy8"
}
```

Error response:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Missing or invalid hosted API credentials."
  }
}
```

### `GET /v1/audits`

Returns audit entries for a user or session. Authenticated.

Query params: `?userId=<id>` or `?sessionId=<id>` and optional `?limit=<n>`

Response `200`:

```json
{
  "audits": [
    {
      "correlationId": "corr_01hxy8",
      "auditRef": "aud_01hxy8",
      "toolName": "transfer_sol",
      "decision": "confirm",
      "riskLevel": "medium",
      "reasons": ["TRANSFER_UNKNOWN_RECIPIENT"],
      "outcome": "success",
      "occurredAt": "2026-06-17T12:00:02.000Z"
    }
  ]
}
```

### `GET /v1/policies`

Returns active policy snapshot. Authenticated.

Response `200`:

```json
{
  "version": "2026-06-17",
  "updatedAt": "2026-06-17T12:00:00.000Z",
  "rules": {
    "transfers": { "maxUsdWithoutApproval": 10 },
    "swaps": { "maxUsdWithoutApproval": 25, "maxSlippageBps": 300 }
  }
}
```

## 7. Security Considerations

- Local-to-hosted authentication uses a revocable bearer token in `COMPASS_HOSTED_API_KEY`.
- Hosted middleware validates auth before schema parsing side effects or audit writes.
- API keys are never included in MCP responses, audit metadata, or debug logs.
- Request logging must use existing redaction patterns from `executionGateway.ts` and `mcpProxyAudit.ts`.
- Hosted LLM calls receive sanitized context only; raw prompts, private keys, signer material, bearer tokens, and session secrets are blocked by schema/redaction.
- `allow` requires `auditRef`; if persistence fails, hosted must deny instead of returning allow.
- Correlation IDs and idempotency keys are required on mutating hosted endpoints.

## 8. Testing Strategy

| Layer | Tests |
| --- | --- |
| Unit | `mcpHostedClient` validates success, timeout, 401, malformed JSON, missing `auditRef`, and abort behavior. |
| Unit | `mcpProxyPolicyInterceptor` keeps local deny/pass classifications unchanged. |
| Unit | Hosted evaluation service maps policy results to `allow`, `deny`, and `confirm`. |
| Unit | Hosted auth middleware rejects missing/invalid credentials without invoking services. |
| Integration | `mcpProxyDispatcher.test.ts` verifies local deny skips HTTP and hosted deny/confirm never executes. |
| Integration | Hosted route tests call Hono app directly for `/health`, `/v1/evaluate`, `/v1/audits`, and `/v1/policies`. |
| E2E | MCP stdio test exercises an allowed read-only call, a local deterministic denial, and a hosted timeout fail-closed case. |

Smallest useful checks should stay in existing Vitest infrastructure (`npm run test:back`). No new test framework is needed.

## 9. Rollout

1. Add hosted contracts and local HTTP client behind `COMPASS_HYBRID_GUARD_ENABLED=false` default.
2. Add Hono hosted app and route-level tests with in-memory audit store.
3. Refactor dispatcher to use hosted evaluation when the flag is enabled; keep current Wave 11 behavior only while migrating tests.
4. Enable hybrid mode in local development with `COMPASS_HOSTED_API_URL` and `COMPASS_HOSTED_API_KEY`.
5. Deploy hosted backend to Vercel and verify `/health` plus authenticated evaluation calls.
6. Flip hybrid mode as the default once MCP stdio E2E passes.
7. Retire downstream stdio config wrapping and in-memory authoritative audit after no tests or scripts depend on them.

Fallback strategy: backend outage never falls back to local allow for high-risk or unknown-risk calls. During rollout, fallback may preserve current local behavior only when `COMPASS_HYBRID_GUARD_ENABLED=false`; once enabled, hosted failure means fail-closed.
