# Proposal: Routed Guardrail Pipeline

## Intent

Replace the current generic heuristic MCP proxy policy as the final authority with a routed guardrail pipeline that identifies Compass-relevant payment actions without overblocking broad MCP usage, then evaluates those operations with deterministic evidence and an LLM decision stage. Compass must review the right tools while preserving usable agent workflows.

## Scope

### In Scope

- Define a deterministic prefilter before any LLM routing.
- Define an LLM router that classifies arbitrary intercepted MCP tools into `transfer`, `swap`, `skip`, or `unknown`.
- Define domain handoff from router output into transfer/swap policy gateways.
- Preserve a separate LLM decision stage inside the guarded operation pipeline after deterministic checks/domain policy evidence is available.

### Out of Scope

- Conditional routing or conditional-buy policy changes.
- Code restructuring, folder moves, or import-only cleanup; treat as a follow-up with no behavior change.
- Implementation tasks, new tools, or execution-path rewrites.
- Final definition of every LLM decision input beyond the currently known evidence sources.

The functional and technical specs under this change document that preparatory restructure follow-up, not the routed pipeline implementation itself. The pipeline implementation remains future work after the restructure.

## Capabilities

### New Capabilities

- `routed-guardrail-pipeline`: Route intercepted MCP tool calls through deterministic prefilters, LLM domain routing, domain policy entrypoints, and a separate LLM decision stage before guarded execution.

### Modified Capabilities

- `wave-7-mcp-compatibility`: Replace generic heuristic proxy authority with routed interception rules for arbitrary downstream tools.
- `wave-10-two-tool-e2e-mcp`: Clarify that transfer/swap remain guarded end-to-end domains while non-Compass tools can skip review.

## Approach

1. Run deterministic pre-routing checks first: schema/input validation, tool metadata risk prefilter, and obvious denies for signing, raw send, malformed wallet/mint/amount/slippage.
2. Route remaining calls through an LLM router using tool name, description, and params. Router outputs `transfer`, `swap`, `skip`, or `unknown`; no confidence field.
3. Send `transfer` to transfer policy/gateway and `swap` to swap policy/gateway. Send `unknown` to the generic guardrail review path. Let `skip` bypass Compass payment review.
4. Run deterministic operation checks/domain policy for the selected domain. These checks produce evidence such as token value, slippage, wallet address risk, policy matches, and any other deterministic safety facts available for the operation.
5. Run a separate LLM decision stage. This is not the router. It evaluates the operation using deterministic check evidence, conversation history, and future contextual inputs still to be defined.
6. Continue through the normal guarded flow: simulation/decoding, approval, audit, signer/execution boundaries, and final response handling as applicable.

## Router vs. LLM Decision

| Stage | Responsibility | Inputs | Output |
|---|---|---|---|
| LLM router | Decide whether Compass should review the intercepted tool and which payment domain applies. | Tool name, description, and parameters. | `transfer`, `swap`, `skip`, or `unknown`. |
| LLM decision | Decide on the operation after deterministic/domain checks have produced evidence. | Deterministic check evidence, conversation history, and future contextual inputs. | Operation decision used by the guarded flow. |

The router must not be treated as the operation decision. It only selects the route. The LLM decision stage is where Compass can reason over the actual operation context.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `docs/routed-guardrail-pipeline/proposal.md` | New | Architecture intent and scope. |
| `back/services/mcp/mcpProxyPolicyInterceptor.ts` | Modified | Future routing boundary replaces final generic heuristic authority. |
| `back/services/transferGateway.ts` | Modified | Future routed transfer entrypoint. |
| `back/services/swapGateway.ts` | Modified | Future routed swap entrypoint. |
| `back/services/llmDecisionAdapter.ts` | Modified | Future operation decision stage after deterministic/domain evidence is available. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Router skips a Compass-relevant tool | Med | Keep deterministic pre-routing denies and send ambiguous cases to `unknown` -> guarded review. |
| Overblocking harms usability | Med | Preserve `skip` for non-Compass tools and avoid using router as final authority. |
| Router and LLM decision responsibilities blur again | Med | Keep separate contracts and tests for route selection vs. operation decision. |

## Rollback Plan

Keep the current generic proxy policy path behind a feature flag or routing switch so Compass can revert to existing interception behavior if routed classification causes misrouting.

## Dependencies

- Existing transfer and swap policy gateways remain the downstream authorities.
- Existing LLM decision support remains a separate decision stage after deterministic/domain evidence exists.
- Existing guarded flow components: simulation/decoding, approval, audit, signer/execution.

## Success Criteria

- [ ] Proposal establishes router, deterministic/domain policy, and LLM decision boundaries without changing runtime behavior yet.
- [ ] `transfer`, `swap`, `skip`, and `unknown` outcomes are defined clearly enough for functional and technical specs.
- [ ] LLM decision is explicitly documented as separate from LLM routing and as consuming deterministic evidence plus conversation history.
