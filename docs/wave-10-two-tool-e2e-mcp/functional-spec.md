# Wave 10 Two-Tool E2E MCP Functional Spec

## Purpose

Wave 10 simplifies the public Compass MCP experience to user-value tools while keeping guardrail orchestration internal. Public write access MUST converge on `compass_transfer` and `compass_swap`; low-level simulation, approval, payload, and execution primitives MUST NOT be exposed as public MCP tools.

## Requirements

### Requirement: Public Write Surface

Compass MUST expose `compass_transfer` and `compass_swap` as the only public write tools for transfer and swap workflows.

#### Scenario: Agent lists public write tools

- GIVEN an MCP client requests the public Compass tool list
- WHEN write-capable tools are returned
- THEN the list MUST include `compass_transfer` and `compass_swap`
- AND it MUST NOT include direct signing, direct execution, transaction payload builder, approval proof handler, raw simulation, or guard-only write primitives.

#### Scenario: Hidden internal primitive is requested directly

- GIVEN an MCP client attempts to call a hidden internal write primitive
- WHEN Compass handles the request through the public MCP surface
- THEN Compass MUST reject the call as unavailable or unsupported
- AND the response MUST NOT reveal bypass instructions.

### Requirement: Safe Read-Only Helpers

Compass MAY keep read-only helper tools public only when they provide user value and expose no sensitive or non-public data.

#### Scenario: Safe helper remains public

- GIVEN a helper only returns public quote, token price, wallet balance, or bounded policy preview data
- WHEN the MCP tool list is produced
- THEN Compass MAY expose the helper publicly.

#### Scenario: Helper exposes sensitive internals

- GIVEN a helper exposes raw transaction payloads, approval artifacts, private risk bypass details, signer material, secrets, or non-public audit data
- WHEN the MCP tool list is produced
- THEN Compass MUST keep the helper internal.

### Requirement: Guarded Transfer Flow

`compass_transfer` MUST run validation, deterministic policy/risk checks, approval gating, internal transaction preparation, execution through the configured non-LLM path where supported, and audit before returning a terminal result.

#### Scenario: Devnet transfer succeeds with explicit demo confirmation

- GIVEN network is `devnet` and `userConfirmedRisk` is `true`
- AND deterministic checks allow the transfer or require approval only
- WHEN an agent calls `compass_transfer`
- THEN Compass MUST complete the supported devnet transfer flow
- AND return a clear success result with execution evidence such as a signature when execution succeeds.

#### Scenario: Transfer is denied by guardrails

- GIVEN deterministic policy or risk checks return `DENY`
- WHEN an agent calls `compass_transfer`
- THEN Compass MUST NOT build, sign, or execute a transaction
- AND MUST return the denial reason and suggested next action.

#### Scenario: Transfer needs more context

- GIVEN required transfer context is missing or invalid
- WHEN an agent calls `compass_transfer`
- THEN Compass MUST return `REQUIRE_ADDITIONAL_CONTEXT`
- AND identify the missing or invalid fields without executing anything.

### Requirement: Approval Boundary

Compass MUST treat chat-based `userConfirmedRisk` as devnet/demo-only. Non-devnet execution MUST require external approval outside chat and outside LLM authority.

#### Scenario: Devnet transfer requires confirmation

- GIVEN network is `devnet` and guardrails require human approval
- WHEN `userConfirmedRisk` is absent or false
- THEN Compass MUST request explicit demo confirmation
- AND MUST NOT execute the transfer in that response.

#### Scenario: Non-devnet request includes chat confirmation

- GIVEN network is `testnet` or `mainnet-beta`
- AND the request includes `userConfirmedRisk: true`
- WHEN an agent calls `compass_transfer` or `compass_swap`
- THEN Compass MUST block execution
- AND state that external production approval is required.

#### Scenario: LLM attempts to approve execution

- GIVEN an LLM response recommends approval or execution
- WHEN Compass evaluates the action
- THEN the LLM output MUST NOT approve or execute the transaction
- AND deterministic and external-approval rules MUST remain authoritative.

### Requirement: Internal Guardrail Orchestration

Compass MUST keep simulation, guard-only evaluation, approval proof handling, transaction payload creation, direct signing, and direct execution behind internal boundaries.

#### Scenario: Public transfer hides orchestration details

- GIVEN an agent calls `compass_transfer`
- WHEN Compass evaluates and executes the supported flow
- THEN the agent MUST NOT be required to pass candidate identifiers, transaction payloads, or approval proofs between public calls.

#### Scenario: Internal payload is not exposed as a public contract

- GIVEN Compass prepares a transaction internally
- WHEN the public response is returned
- THEN Compass SHOULD return user-relevant status and execution evidence
- AND MUST NOT require the client to manage raw internal payload lifecycle.

### Requirement: Swap Flow Scope

`compass_swap` MUST provide a guarded swap entrypoint while preserving the current swap provider/check model until a dedicated swap execution builder is designed.

#### Scenario: Swap policy checks complete

- GIVEN a swap request includes supported quote, token, protocol, and slippage context
- WHEN an agent calls `compass_swap`
- THEN Compass MUST run current deterministic swap checks
- AND return allow, deny, approval-required, or additional-context status with clear reasons.

#### Scenario: Swap execution is not yet supported

- GIVEN a swap request reaches a path without supported execution building
- WHEN Compass returns the result
- THEN Compass MUST NOT fake execution
- AND MUST clearly state that swap execution is pending a dedicated execution builder.

### Requirement: Clear Results And Auditability

Compass MUST return clear, actionable outcomes for allowed, denied, approval-required, additional-context, unsupported, and failed execution states.

#### Scenario: Result is blocked or unsupported

- GIVEN Compass blocks or cannot support an action
- WHEN it returns the MCP result
- THEN the result MUST include a stable status, reason, and suggested next action.

#### Scenario: Supported action reaches terminal processing

- GIVEN Compass completes a supported transfer flow or swap evaluation
- WHEN the result is returned
- THEN Compass SHOULD record audit-relevant decision and outcome data
- AND MUST avoid exposing secrets, signer material, or sensitive internal payloads.
