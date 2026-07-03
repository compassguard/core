# Wave 4 — MCP server and tool boundary functional spec

## Summary

Wave 4 turns the post-Wave-3.5 backend core into an agent-facing boundary: a local MCP server that exposes Compass-controlled tools through `tools/list` and `tools/call`.

This wave exists because `back/services/*` is currently a clean library/core, but no active entrypoint consumes it. The previous transfer caller lives in `legacy/back/services/chat.ts`; new agent traffic must enter through Compass MCP Guard instead.

## Goals

- Expose Compass as a local MCP server/tool boundary for first-party Compass tools.
- Provide deterministic `tools/list` output for the initial safe tool set.
- Intercept `tools/call` and route each call through classification, policy, transfer guard, and audit.
- Produce the three MVP outcomes through MCP:
  - `ALLOW` for safe read/preparation;
  - `REQUIRE_HUMAN_APPROVAL` for a risky but policy-manageable transfer;
  - `DENY` for direct signing, unknown mutating tools, or policy-forbidden actions.
- Keep the active tree isolated from `legacy/`.

## Non-goals

- Do not build the signer adapter yet. That is Wave 6.
- Do not migrate swaps or conditional orders yet. That is Wave 5.
- Do not add broad upstream MCP compatibility/passthrough yet. That is Wave 7.
- Do not add custody of user private keys.
- Do not make durable audit storage a requirement for this wave.
- Do not reintroduce the legacy chat product as the entrypoint.

## Initial tool set

| Tool                        | Risk class          | Expected default behavior                                                                               |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `get_usdc_sol_quote`        | read/preparation    | `ALLOW` + audit                                                                                         |
| `guarded_transfer_sol`      | sensitive execution | evaluates through `transferGateway`; may return `REQUIRE_HUMAN_APPROVAL`, `DENY`, or additional context |
| `sign_and_send_transaction` | signing             | `DENY` unless a later signer-adapter wave proves Compass-built approval metadata                        |
| unknown mutating tool       | blocked/unknown     | `DENY` fail-closed                                                                                      |

The exact public names may be adjusted during implementation, but the behavior above is required.

## User-visible behavior

### Scenario 1 — safe quote is allowed

Given an AI host calls `tools/list`, when Compass responds, then the safe quote tool is listed with description, input schema, and risk class metadata.

Given the AI host calls the quote tool with valid input, when Compass handles `tools/call`, then Compass returns an `ALLOW` result and records an audit event.

### Scenario 2 — risky transfer requires approval

Given an AI host calls the guarded transfer tool for an unknown recipient or amount over policy threshold, when Compass handles `tools/call`, then Compass evaluates the request through `evaluateTransferGateway` and returns a structured `REQUIRE_HUMAN_APPROVAL` result with reason codes and approval metadata.

### Scenario 3 — forbidden signing is denied

Given an AI host calls a direct signing or raw send tool, when Compass handles `tools/call`, then Compass returns `DENY` with a clear reason and records an audit event.

### Scenario 4 — unknown mutating tool fails closed

Given an AI host calls a tool not in the Compass registry and the call looks mutating, when Compass handles `tools/call`, then Compass denies the call rather than passing it through.

## Acceptance criteria

- `tools/list` returns only Compass-controlled tools for this wave.
- `tools/call` uses the existing classification and policy path.
- The transfer tool calls `evaluateTransferGateway` and never imports from `legacy/`.
- All outcomes include stable machine-readable decision/reason data.
- Audit events redact raw prompts, raw transactions, and secrets.
- Backend tests cover allow, require approval, deny, and unknown-tool fail-closed cases.

## Verification

- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`
- Manual local evidence for `tools/list` and three `tools/call` outcomes once the server entrypoint exists.
