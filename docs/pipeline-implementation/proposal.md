# Proposal: Pipeline Implementation

## Intent

Implement the routed guardrail pipeline behavior prepared by `docs/routed-guardrail-pipeline/`: the MCP proxy should stop treating the heuristic classifier as final authority for unknown tools and instead route ambiguous calls through an LLM Router that can hand transfer/swap operations to existing domain gateways and the advisory LLM Decision stage.

## Scope

### In Scope

- Add `back/services/intelligence/llm-router/` contracts, adapter, and prompt for `transfer`, `swap`, `skip`, or `unknown` classification.
- Add a dispatcher routing hook after deterministic proxy prefiltering.
- Preserve deterministic allow for `read_only`, `ui_bootstrap`, and `preparation_simulation` without calling the LLM Router.
- Route `transfer` and `swap` classifications into existing domain gateways.
- Call the existing `intelligence/llm-decision/` advisory judge after transfer/swap gateway policy checks.
- Clamp LLM Decision output so it can only keep or tighten gateway decisions.
- Record routing decisions in proxy audit events.

### Out of Scope

- New transfer or swap gateway policy behavior.
- New LLM decision adapter behavior or decision-clamp contract changes.
- Policy engine changes.
- MCP protocol surface changes.
- New runtime dependencies.

## Capabilities

### New Capabilities

- `pipeline-implementation`: Implements proxy-to-router-to-domain handoff for routed guardrail execution.

### Modified Capabilities

- `routed-guardrail-pipeline`: Converts the documented future behavior into the active MCP proxy path.
- `wave-11-mcp-proxy-architecture`: Changes unknown proxy handling from local `require_approval` only to optional LLM routing before final decision.

## Approach

The dispatcher keeps the existing deterministic prefilter first:

```txt
MCP proxy -> deterministic prefilter -> read_only/ui/prep -> allow
                                 -> signing -> deny
                                 -> sensitive -> deny
                                 -> unknown -> LLM Router
                                   -> transfer -> transferGateway -> LLM Decision -> allow/require_approval/deny
                                   -> swap -> swapGateway -> LLM Decision -> allow/require_approval/deny
                                   -> skip -> allow
                                   -> unknown -> require_approval
```

The LLM Router is a separate intelligence boundary from `llm-decision`. It receives sanitized tool name, description if available from `tools/list`, and arguments. It returns only the route and reason codes. It does not approve, deny, sign, simulate, or loosen downstream guardrails.

The LLM Decision stage already exists under `back/services/intelligence/llm-decision/`. The dispatcher prepares route-specific, sanitized judge input after the transfer or swap gateway evaluates policy. Transfer input includes amount, recipient, token/SOL, wallet safety validation, gateway decision, and recipient/amount/suspicious-flag risk signals. Swap input includes token in/out, amount, slippage, protocol, token risk score, gateway decision, and unknown-token/high-slippage/risky-protocol risk signals.

LLM Decision cannot loosen deterministic gateway decisions. If a gateway denies, final output stays denied. If a gateway allows or requires approval, the LLM can keep that result or tighten it to `require_approval`/`deny`. If `COMPASS_LLM_DECISION_ENABLED` is false or the judge is unavailable, the gateway decision stands as-is.

`skip` means non-Compass/no payment review and can forward through normal proxy audit. Router failure, invalid output, timeout, or `unknown` maps to `require_approval` fail-closed behavior.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `back/services/intelligence/llm-router/` | New | Router contracts, adapter, prompt, and validation. |
| `back/services/intelligence/llm-decision/` | Reused | Existing advisory judge receives route-specific transfer/swap context and clamps against gateway decisions. |
| `back/services/mcp/proxy/mcpProxyDispatcher.ts` | Modified | Calls router only after deterministic `unknown`. |
| `back/services/mcp/proxy/mcpProxyPolicyInterceptor.ts` | Modified | Exposes deterministic risk class/decision data for routing hook. |
| `back/services/mcp/proxy/mcpProxyAudit.ts` | Modified | Logs route, reason codes, and fallback outcome. |
| `back/services/domains/{transfer,swap}/` | Reused | Existing gateway entrypoints receive routed calls and provide deterministic decisions for LLM Decision clamping; no policy behavior changes. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Router misclassifies a payment tool as `skip` | Medium | Keep deterministic denies first and require strict prompt/tests for obvious transfer/swap names and params. |
| Router output becomes implicit approval | Medium | Contracts must state route-only authority; gateways remain policy authorities. |
| LLM Decision loosens a gateway denial | Low | Reuse existing decision clamp and test deny cannot become allow. |
| Missing tool descriptions reduce accuracy | Medium | Route using tool name and params; ambiguous cases stay `unknown`. |

## Rollback Plan

Disable the router hook and restore current proxy behavior: deterministic allows still forward, signing/sensitive still deny, and unknown returns `require_approval` without domain handoff. Disable `COMPASS_LLM_DECISION_ENABLED` to keep transfer/swap gateway decisions as final while preserving routed handoff.

## Dependencies

- Existing proxy dispatcher, policy interceptor, and audit helpers.
- Existing transfer and swap gateway evaluators.
- Existing LLM provider pattern and clamp from `llm-decision`, reused without adding dependencies.

## Success Criteria

- [ ] Read-only/UI/prep tools pass without LLM Router calls.
- [ ] Unknown tools call the router when configured and fail closed on invalid output or timeout.
- [ ] `transfer` and `swap` routes call existing domain gateways.
- [ ] Transfer/swap gateway decisions are passed through LLM Decision when enabled.
- [ ] LLM Decision can only keep or tighten gateway decisions.
- [ ] `skip` forwards through proxy with an auditable routing reason.
- [ ] Router and LLM decision contracts remain separate.
