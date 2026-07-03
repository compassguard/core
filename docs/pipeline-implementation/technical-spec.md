# Pipeline Implementation Technical Spec

## Architecture Overview

The routed guardrail pipeline keeps the existing MCP proxy dispatcher as the only `tools/call` boundary. `evaluateProxyToolCallPolicy()` remains the deterministic prefilter. The new LLM Router is consulted only when the deterministic result is `require_approval`, which is the current outcome for unknown tools. It is route-only: it can select a downstream guardrail path, but it cannot approve signing, bypass policy, or execute on-chain actions. Routed transfer/swap operations then pass through their existing domain gateway and the existing advisory LLM Decision stage before the dispatcher returns a final decision.

```txt
tools/call
  -> evaluateProxyToolCallPolicy()
    -> read_only/ui_bootstrap/preparation_simulation -> allow -> downstream.callTool
    -> sensitive_execution/signing -> deny
    -> unknown -> require_approval
      -> router enabled? no -> require_approval
      -> router enabled? yes -> LLM Router
        -> transfer -> evaluateTransferGateway()
          -> gateway deny -> final deny
          -> gateway allow/require_approval -> LLM Decision -> clamped final decision
        -> swap -> evaluateSwapGateway()
          -> gateway deny -> final deny
          -> gateway allow/require_approval -> LLM Decision -> clamped final decision
        -> skip -> allow -> downstream.callTool
        -> unknown -> require_approval
```

The router reuses the provider pattern from `llm-decision`: environment-driven config, default-off behavior, `fetch`-based provider calls, `AbortController` timeout, JSON validation, and fail-closed fallback. It does not share contracts with `llm-decision`; classification is a separate intelligence boundary. LLM Decision integration reuses `sanitizeLlmJudgeInput()`, `resolveLlmConfig()`, and `evaluateLlmMetadata()` instead of adding a new judge.

## Architecture Decisions

| Decision | Choice | Tradeoff / Rationale |
| --- | --- | --- |
| Router placement | Hook after `evaluateProxyToolCallPolicy()` returns `require_approval`. | Preserves deterministic allow/deny behavior and limits LLM exposure to ambiguous tools only. |
| Router authority | `transfer`, `swap`, `skip`, or `unknown` route selection only. | Keeps domain gateways and approval flow as enforcement authorities; avoids turning LLM output into approval. |
| Feature flag | `COMPASS_LLM_ROUTER_ENABLED=false` by default. | Rollback is one env change and current heuristic-only behavior remains unchanged by default. |
| Provider reuse | Use `COMPASS_LLM_PROVIDER`, `COMPASS_LLM_MODEL`, `COMPASS_LLM_API_KEY`, `COMPASS_LLM_BASE_URL`. | No new dependencies or provider config surface. Router has its own timeout flag only. |
| LLM Decision placement | Call after `evaluateTransferGateway()` / `evaluateSwapGateway()` and before returning final routed decision. | Gives the judge gateway context and keeps deterministic policy first. |
| Decision clamp | Use existing `evaluateLlmMetadata()` clamp against the gateway decision. | LLM can only keep or tighten gateway results; gateway deny stays deny. |
| Failure behavior | Timeout, provider error, invalid JSON, or unsupported route returns `unknown`. | Fails closed into existing `require_approval`; this is boring and correct for a guardrail. |

## New Files

| File | Action | Description |
| --- | --- | --- |
| `back/services/intelligence/llm-router/llmRouterContracts.ts` | Create | Router input/output/result/config contracts. |
| `back/services/intelligence/llm-router/llmRouterAdapter.ts` | Create | Provider-backed `routeToolCall()` with validation, timeout, and fail-closed fallback. |
| `back/services/intelligence/llm-router/llmRouterPrompt.ts` | Create | System prompt and classification instructions. |

## Files To Modify

| File | Action | Description |
| --- | --- | --- |
| `back/services/mcp/proxy/mcpProxyDispatcher.ts` | Modify | After `require_approval`, optionally call `routeToolCall()` when `COMPASS_LLM_ROUTER_ENABLED=true`; map `skip` to forward, `unknown` to approval, and `transfer`/`swap` to gateway handoff followed by LLM Decision clamping. |
| `back/services/mcp/proxy/mcpProxyContracts.ts` | Modify | Optionally extend `ProxyDecision` with routing metadata for audit/debug without changing MCP protocol shape. |
| `back/services/mcp/proxy/mcpProxyAudit.ts` | Modify | Add `proxy_routing_decision` audit event and recorder. |
| `back/services/intelligence/llm-decision/*` | Reuse | No source changes planned; dispatcher imports existing config, sanitizer, and clamped evaluation helpers. |

## Interfaces / Contracts

```ts
export type LlmRouterInput = {
  toolName: string;
  toolDescription?: string;
  toolParams?: Record<string, unknown>;
};

export type LlmRouterOutput = "transfer" | "swap" | "skip" | "unknown";

export type LlmRouterResult = {
  classification: LlmRouterOutput;
  reasoning: string;
  latencyMs: number;
};

export type LlmRouterConfig = {
  enabled: boolean;
  timeoutMs: number;
  provider?: string;
  model?: string;
};
```

`routeToolCall(input, config)` sends this system prompt:

```txt
You are a tool classifier. Given a tool name, description, and parameters, classify it as one of: transfer, swap, skip, unknown. Return JSON: { classification: string, reasoning: string }
```

`llmRouterPrompt.ts` expands the instruction: `transfer` means sending funds/tokens to another address, `swap` means exchanging tokens, `skip` means read-only or informational, and `unknown` means unclear or potentially dangerous.

## Dispatcher Routing Hook

```ts
const route = await routeToolCall(routerInput, routerConfig);

if (route.classification === "transfer") {
  const gateway = await evaluateTransferGateway(transferInput);
  return applyLlmDecision("transfer", gateway, transferRiskContext);
}

if (route.classification === "swap") {
  const gateway = await evaluateSwapGateway(swapInput);
  return applyLlmDecision("swap", gateway, swapRiskContext);
}
```

`applyLlmDecision()` is a dispatcher-local integration step, not a new domain service. It extracts `gateway.policyEvaluation.decision`, prepares sanitized `LlmJudgeInput`, calls `evaluateLlmMetadata()` when enabled, and maps the clamped decision back to proxy allow/approval/deny output.

## LLM Decision Input Preparation

| Route | `actionKind` | `rawContext` fields before sanitizer |
| --- | --- | --- |
| `transfer` | `transfer` | `amount`, `recipientAddress`, `token`, `walletSafetyValidation`, `gatewayDecision`, `recipientKnown`, `amountOverLimit`, `suspiciousFlags`. |
| `swap` | `swap` | `inputToken`, `outputToken`, `inputAmount`, `slippageBps`, `protocol`, `tokenRiskScore`, `gatewayDecision`, `unknownToken`, `highSlippage`, `riskyProtocol`. |

The dispatcher MUST pass gateway metadata into standard judge fields where possible:

```ts
sanitizeLlmJudgeInput({
  toolName,
  actionKind: route.classification,
  network,
  deterministicDecision: gateway.policyEvaluation.decision,
  riskClass,
  reasonCodes: gateway.policyEvaluation.reasonCodes,
  policyId: gateway.policyEvaluation.policyId,
  evaluatedRules: gateway.policyEvaluation.evaluatedRules,
  rawContext: routeSpecificContext,
});
```

## Decision Combination

```txt
gateway decision -> sanitize route-specific context -> evaluateLlmMetadata()
  -> disabled/unconfigured/error -> gateway decision
  -> LLM keeps decision -> gateway decision
  -> LLM tightens allow -> require_approval or deny
  -> LLM tries to loosen deny -> deny
```

The implementation MUST preserve the existing strictness model from `LLM_DECISION_STRICTNESS`. For proxy output, `REQUIRE_HUMAN_APPROVAL` and `REQUIRE_ADDITIONAL_CONTEXT` both map to `require_approval` unless a narrower existing proxy status is already available.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPASS_LLM_ROUTER_ENABLED` | `false` | Enables dispatcher router hook. |
| `COMPASS_LLM_ROUTER_TIMEOUT_MS` | `3000` | Router provider timeout. |
| `COMPASS_LLM_DECISION_ENABLED` | existing env value | Enables existing advisory judge after transfer/swap gateway checks. |
| `COMPASS_LLM_PROVIDER` | existing default | Provider key reused from LLM decision pattern. |
| `COMPASS_LLM_MODEL` | existing default | Model name. |
| `COMPASS_LLM_API_KEY` | unset | Provider credential; never audited. |
| `COMPASS_LLM_BASE_URL` | unset | Provider endpoint for compatible runtimes. |

## Error Handling Strategy

| Failure | Result |
| --- | --- |
| LLM timeout | `unknown` -> `require_approval`. |
| Invalid JSON or unsupported classification | `unknown` -> `require_approval`. |
| Provider unavailable/error | `unknown` -> `require_approval`. |
| Transfer/swap gateway unavailable | `require_approval` with suggestion to enable/configure gateway handoff. |
| LLM Decision disabled/unconfigured/error | Preserve gateway decision. |
| LLM Decision tries to loosen gateway denial | Preserve gateway denial. |
| Audit intent failure before forwarding `skip` | Existing fail-closed deny behavior. |

## Testing Approach

| Layer | What to Test | Approach |
| --- | --- | --- |
| Unit | `llmRouterAdapter` validates `transfer`, `swap`, `skip`, `unknown`. | Inject mock provider function; assert invalid JSON/error/timeout returns `unknown`. |
| Unit | Dispatcher does not call router for deterministic allow/deny. | Fake downstream plus mock router hook/config. |
| Unit | Dispatcher maps router output correctly. | `skip` forwards; `unknown` requires approval; `transfer`/`swap` call domain gateways. |
| Unit | LLM Decision input differs by route. | Mock gateway outputs and assert transfer context includes wallet safety while swap context includes token/slippage/protocol signals. |
| Unit | LLM Decision clamp is enforced. | Gateway `deny` plus LLM `allow` remains deny; gateway `allow` plus LLM `require_approval` tightens. |
| Integration | Mock LLM Router returns `transfer` or `swap`. | Verify dispatcher records routing event, calls gateway, calls LLM Decision when enabled, and returns clamped final decision. |

## Migration / Rollback

No data migration required. Ship router code behind `COMPASS_LLM_ROUTER_ENABLED=false`. Enabling the flag affects only unknown tools; deterministic read-only allows and sensitive/signing denies stay unchanged. Rollback is setting `COMPASS_LLM_ROUTER_ENABLED=false`, which returns the proxy to current heuristic-only `require_approval` behavior for unknown tools. If routed gateway handoff should remain active without the advisory judge, set `COMPASS_LLM_DECISION_ENABLED=false` so gateway decisions stand as-is.

## Open Questions

- [ ] Should tool descriptions be cached from `tools/list`, or should the first slice route with name and params only when no descriptor is available?
