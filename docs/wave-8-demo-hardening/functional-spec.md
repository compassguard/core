# Wave 8 — Demo hardening functional spec

Wave 8 makes Compass MCP Guard reviewable and demoable without overstating production readiness. It turns the current MCP/tool boundary into a repeatable local demo that shows Compass allowing safe preparation, requiring approval for risky execution, and denying unsafe direct signing or prompt-injection style execution.

## Goals

- Provide a local demo runbook that a reviewer can execute without reading secrets.
- Show the three MVP outcomes: `ALLOW`, `REQUIRE_HUMAN_APPROVAL`, and `DENY`.
- Include redacted audit examples that prove sensitive payloads do not leak into user-facing results or audit metadata.
- Make devnet/testnet/mainnet status explicit for the MVP.
- Keep Wave 8 as demo hardening only: no new wallet custody model, no mainnet execution claim, and no broad upstream MCP passthrough.

## Non-Goals

- No production private-key custody.
- No mainnet signing readiness.
- No durable audit storage.
- No hosted dashboard.
- No new frontend approval UI.
- No upstream MCP compatibility beyond the existing Compass-controlled tools.

## Requirements

### Requirement: Demo Runbook

Compass MUST include a runbook that can be followed from the repo root.

#### Scenario: Reviewer runs the happy-path demo

- GIVEN dependencies are installed
- WHEN the reviewer follows the Wave 8 runbook
- THEN the reviewer sees one allowed read/preparation call
- AND one approval-required guarded transfer
- AND one denied unsafe execution call
- AND no secret or raw transaction sentinel leaks into the result.

### Requirement: Audit Examples

Compass MUST document representative audit events for the demo outcomes.

#### Scenario: Audit event contains sensitive input

- GIVEN a tool call includes a raw transaction sentinel or prompt-like sensitive field
- WHEN Compass records the audit event
- THEN the documented example MUST show sensitive values redacted or absent
- AND the example MUST preserve enough fields for review: `candidateId`, `decision`, `riskClass`, `result`, `reasonCodes`, and metadata status fields.

### Requirement: Failure Messages And Suggested Action

Demo documentation MUST explain what a reviewer should do after each failure mode.

#### Scenario: Compass denies direct signing

- GIVEN an agent calls direct `sign_and_send_transaction`
- WHEN Compass denies the call
- THEN the runbook MUST explain that the caller should route through guarded preparation plus `execute_approved_action` after approval.

### Requirement: Network Readiness

Wave 8 MUST state network readiness plainly.

#### Scenario: Mainnet readiness is reviewed

- GIVEN a reviewer reads the demo documentation
- WHEN they look for production readiness claims
- THEN the docs MUST state that local signer execution is demo/devnet-oriented and mainnet local signer execution is blocked for the MVP.
