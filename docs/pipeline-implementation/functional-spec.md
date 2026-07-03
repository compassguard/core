# Pipeline Implementation Functional Spec

## 1. Purpose

This spec covers implementing the LLM Router and dispatcher routing hook so the MCP proxy can classify downstream tools and route them through the appropriate guardrails. The pipeline MUST keep deterministic proxy prefiltering first, use the LLM Router only for ambiguous downstream tools, route classified transfer/swap operations through the existing domain gateway boundaries, and then call the existing advisory LLM Decision stage before finalizing routed operation decisions.

## 2. Scope

| In scope | Out of scope |
| --- | --- |
| LLM Router contracts, adapter, prompt, dispatcher integration, LLM Decision integration after transfer/swap gateways, and audit. | Domain gateway policy behavior changes, LLM decision adapter behavior changes, policy engine changes, MCP protocol changes, and new external dependencies. |

## 3. Actors And Components

- MCP Proxy: dispatcher and policy interceptor that intercept downstream `tools/call` requests.
- Deterministic Prefilter: `classifyProxyToolCall`, used before any LLM routing.
- LLM Router: new `llmRouterContracts`, `llmRouterAdapter`, and `llmRouterPrompt` boundary.
- Domain Gateways: existing `transferGateway` and `swapGateway`, reused without behavior changes.
- LLM Decision: existing `llmDecisionAdapter`, `llmDecisionContracts`, and `llmDecisionSanitizer` advisory judge.
- Approval Flow: existing `require_approval` response used for ambiguous or failed routing.
- Audit Sink: `mcpProxyAudit`, extended with routing decision and router call events.

## 4. Requirements

### R1: LLM Router Classifies Tools

The LLM Router MUST classify ambiguous downstream tools as exactly one of `transfer`, `swap`, `skip`, or `unknown`.

#### Scenario R1.1: Router receives tool input

- GIVEN an unknown downstream tool reaches the router
- WHEN the router is called
- THEN it MUST receive `toolName`, `toolDescription`, and `toolParams`.

#### Scenario R1.2: Router returns a supported route

- GIVEN the LLM provider returns a valid route
- WHEN the router validates the response
- THEN the route MUST be one of `transfer`, `swap`, `skip`, or `unknown`.

#### Scenario R1.3: Router uses configured provider

- GIVEN `COMPASS_LLM_*` provider settings are configured
- WHEN the router calls an LLM
- THEN it MUST use the configured provider settings.

#### Scenario R1.4: Router timeout returns unknown

- GIVEN the provider does not respond before the router timeout
- WHEN the timeout reaches 3 seconds by default
- THEN the router MUST return `unknown`.

#### Scenario R1.5: Invalid LLM JSON returns unknown

- GIVEN the provider returns invalid JSON within the timeout
- WHEN the router validates the output
- THEN the router MUST return `unknown`.

#### Scenario R1.6: Provider error returns unknown

- GIVEN the provider call fails within the timeout
- WHEN the router handles the error
- THEN the router MUST return `unknown`.

### R2: Deterministic Prefilter Skips LLM For Obvious Cases

The dispatcher MUST use deterministic classification before any router call.

#### Scenario R2.1: Read-only tools are allowed

- GIVEN a tool is classified as `read_only`
- WHEN the dispatcher evaluates the call
- THEN it MUST allow without calling the LLM Router.

#### Scenario R2.2: UI bootstrap tools are allowed

- GIVEN a tool is classified as `ui_bootstrap`
- WHEN the dispatcher evaluates the call
- THEN it MUST allow without calling the LLM Router.

#### Scenario R2.3: Preparation simulation tools are allowed

- GIVEN a tool is classified as `preparation_simulation`
- WHEN the dispatcher evaluates the call
- THEN it MUST allow without calling the LLM Router.

#### Scenario R2.4: Signing tools are denied

- GIVEN a tool is classified as `signing`
- WHEN the dispatcher evaluates the call
- THEN it MUST deny without calling the LLM Router.

#### Scenario R2.5: Sensitive execution tools are denied

- GIVEN a tool is classified as `sensitive_execution`
- WHEN the dispatcher evaluates the call
- THEN it MUST deny without calling the LLM Router.

#### Scenario R2.6: Unknown tools are routed

- GIVEN a tool is classified as `unknown`
- WHEN the router is enabled and configured
- THEN the dispatcher MUST send it to the LLM Router.

### R3: Dispatcher Routes Based On Router Output

The dispatcher MUST treat router output as route selection only, not approval authority. Transfer and swap routes MUST continue through their domain gateways before any LLM Decision call.

#### Scenario R3.1: Transfer route reaches transfer gateway boundary

- GIVEN the router returns `transfer`
- WHEN the dispatcher handles the route
- THEN it MUST forward to the existing `transferGateway` boundary.

#### Scenario R3.2: Swap route reaches swap gateway boundary

- GIVEN the router returns `swap`
- WHEN the dispatcher handles the route
- THEN it MUST forward to the existing `swapGateway` boundary.

#### Scenario R3.3: Skip route allows without domain gateway

- GIVEN the router returns `skip`
- WHEN the dispatcher handles the route
- THEN it MUST allow without invoking a domain gateway.

#### Scenario R3.4: Unknown route requires approval

- GIVEN the router returns `unknown`
- WHEN the dispatcher handles the route
- THEN it MUST return `require_approval`.

#### Scenario R3.5: Disabled router preserves current behavior

- GIVEN `COMPASS_LLM_ROUTER_ENABLED` is false or absent
- WHEN an unknown tool is evaluated
- THEN the dispatcher MUST fall back to current heuristic-only behavior.

### R4: Audit Trail

Routing MUST be auditable without persisting provider secrets.

#### Scenario R4.1: Routing decision is logged

- GIVEN the dispatcher makes a routing decision
- WHEN audit is recorded
- THEN it MUST include tool name, classification, decision, and latency.

#### Scenario R4.2: LLM router call is logged

- GIVEN the LLM Router is called
- WHEN audit is recorded
- THEN it MUST include router input, output, latency, and errors when present.

### R5: Configuration

Router behavior MUST be controlled by environment configuration.

#### Scenario R5.1: Router can be disabled

- GIVEN `COMPASS_LLM_ROUTER_ENABLED` is false or absent
- WHEN the dispatcher evaluates a tool
- THEN it MUST NOT call the LLM Router.

#### Scenario R5.2: Router reuses provider config

- GIVEN existing `COMPASS_LLM_*` provider config is present
- WHEN the router resolves configuration
- THEN it MUST use that provider config.

#### Scenario R5.3: Router timeout is configurable

- GIVEN `COMPASS_LLM_ROUTER_TIMEOUT_MS` is set
- WHEN the router calls the provider
- THEN it MUST use that timeout, defaulting to 3000 ms when absent.

### R6: LLM Decision Evaluates Routed Operations

The dispatcher MUST call the existing LLM Decision stage after routed transfer/swap gateway checks when LLM Decision is enabled. LLM Decision MUST receive route-specific sanitized input and MUST NOT loosen deterministic gateway decisions.

#### Scenario R6.1: Transfer gateway result reaches LLM Decision

- GIVEN the router returns `transfer`
- AND `transferGateway` returns an approval-eligible decision
- WHEN `COMPASS_LLM_DECISION_ENABLED` is true
- THEN LLM Decision MUST evaluate the transfer before the final decision.

#### Scenario R6.2: Swap gateway result reaches LLM Decision

- GIVEN the router returns `swap`
- AND `swapGateway` returns an approval-eligible decision
- WHEN `COMPASS_LLM_DECISION_ENABLED` is true
- THEN LLM Decision MUST evaluate the swap before the final decision.

#### Scenario R6.3: Transfer input is route-specific

- GIVEN a transfer is sent to LLM Decision
- WHEN judge input is prepared
- THEN it MUST include amount, recipient address, token/SOL, wallet safety validation, gateway policy decision, and recipient/amount/suspicious-flag risk signals.

#### Scenario R6.4: Swap input is route-specific

- GIVEN a swap is sent to LLM Decision
- WHEN judge input is prepared
- THEN it MUST include token in, token out, amount, slippage, protocol, token risk score, gateway policy decision, and unknown-token/high-slippage/risky-protocol risk signals.

#### Scenario R6.5: LLM Decision cannot override deterministic deny

- GIVEN a transfer or swap gateway returns `deny`
- WHEN LLM Decision returns `allow`
- THEN the final decision MUST remain `deny`.

#### Scenario R6.6: LLM Decision can tighten allow

- GIVEN a transfer or swap gateway returns `allow`
- WHEN LLM Decision returns `require_approval` based on risk signals
- THEN the final decision MUST be `require_approval`.

#### Scenario R6.7: Disabled LLM Decision preserves gateway result

- GIVEN `COMPASS_LLM_DECISION_ENABLED` is false
- WHEN a transfer or swap gateway returns a decision
- THEN the dispatcher MUST use the gateway decision as-is.

## 5. Error Handling

- LLM timeout MUST return `unknown`, causing `require_approval` so the user can still approve manually.
- LLM invalid output MUST return `unknown`, causing `require_approval`.
- LLM provider failure MUST return `unknown`, causing `require_approval`.
- Gateway unavailable MUST return `require_approval` with a suggestion to check gateway configuration.
- LLM Decision disabled, unconfigured, invalid output, timeout, or provider failure MUST preserve the gateway decision.
- LLM Decision output MUST be clamped so gateway `deny` cannot become `allow` or `require_approval`.

## 6. Non-Goals

- No new domain gateway policy behavior.
- No new LLM decision adapter behavior or clamp contract changes.
- No policy engine changes.
- No MCP protocol changes.
- No new external dependencies.
