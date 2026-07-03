# Hybrid Architecture Functional Spec

## 1. Overview

This spec defines the functional behavior for moving Compass MCP Guard from a monolithic local stdio proxy to a hybrid local and hosted architecture. The local proxy remains the MCP stdio boundary for agents, while hosted services provide risk evaluation, policy decisions, audit persistence, and optional LLM evaluation over HTTP.

## 2. Actor and System Boundaries

| Actor/System | Boundary |
| --- | --- |
| AI agent / MCP client | Connects only to the local Compass MCP stdio proxy. |
| Local proxy | Normalizes tool calls, runs deterministic checks, calls hosted HTTP APIs, and enforces decisions before execution. |
| Hosted backend | Owns durable risk, policy, audit, LLM, and health endpoints. |
| Operator | Configures local proxy credentials, backend URL, and observes failures. |

## 3. Functional Requirements

### Local Proxy Responsibilities

- **FR-LOCAL-001**: The local proxy MUST remain the only MCP stdio server exposed to agents.
- **FR-LOCAL-002**: The local proxy MUST normalize every tool call into a stable evaluation request containing tool name, arguments, agent context, local findings, and correlation ID.
- **FR-LOCAL-003**: The local proxy MUST run deterministic local checks before any hosted API call.
- **FR-LOCAL-004**: The local proxy MUST deny locally blocked calls without contacting the hosted backend.
- **FR-LOCAL-005**: The local proxy MUST enforce hosted `allow`, `deny`, or `confirm` decisions before forwarding or executing a tool call.
- **FR-LOCAL-006**: The local proxy MUST return a stable reason and suggested next action for every denied or failed call.

### Hosted Backend Responsibilities

- **FR-HOSTED-001**: The hosted backend MUST expose health, tool-call evaluation, audit event, and LLM evaluation endpoints.
- **FR-HOSTED-002**: The hosted backend MUST evaluate risk using tool data, local findings, policy version, and agent context.
- **FR-HOSTED-003**: The hosted backend MUST return a decision of `allow`, `deny`, or `confirm` with reasons, risk level, policy version, and audit reference when persistence succeeds.
- **FR-HOSTED-004**: The hosted backend MUST keep risk, policy, audit, and LLM evaluation deployable independently from the local proxy.
- **FR-HOSTED-005**: The hosted backend MUST reject unauthenticated or malformed requests without creating an allow decision.

### HTTP API Contract Requirements

- **FR-API-001**: `GET /health` MUST indicate whether hosted evaluation dependencies are available.
- **FR-API-002**: `POST /v1/evaluations/tool-call` MUST accept tool name, arguments, agent context, local findings, and correlation ID.
- **FR-API-003**: `POST /v1/evaluations/tool-call` MUST return `allow`, `deny`, or `confirm` plus reasons, risk level, and audit reference.
- **FR-API-004**: `POST /v1/audit/events` MUST accept decision and execution events with correlation ID and idempotency key.
- **FR-API-005**: `POST /v1/llm/evaluate` MUST return a bounded decision explanation for ambiguous cases and MUST NOT directly execute tools.

### Audit Persistence Requirements

- **FR-AUDIT-001**: The hosted backend MUST persist every hosted-evaluated tool call with correlation ID, request summary, decision, reasons, risk level, policy version, and timestamp.
- **FR-AUDIT-002**: The local proxy MUST send execution outcome events after an allowed or confirmed call completes or fails.
- **FR-AUDIT-003**: Audit writes MUST be idempotent by correlation ID and event key.
- **FR-AUDIT-004**: A call MUST NOT be treated as fully evaluated unless its hosted decision includes an audit reference or an explicit audit-degraded denial.

### Failure Mode Requirements

- **FR-FAIL-001**: The local proxy MUST fail closed for high-risk or unknown-risk tool calls when the hosted backend is unavailable.
- **FR-FAIL-002**: The local proxy MUST fail closed when hosted responses are malformed, unauthenticated, timed out, or missing required decision fields.
- **FR-FAIL-003**: The local proxy MUST expose actionable operator guidance for backend URL, credentials, and timeout failures.

## 4. Scenarios

### Normal tool call flow

- GIVEN an agent calls a guarded tool through local MCP stdio
- WHEN local checks pass and hosted evaluation returns `allow`
- THEN the local proxy MUST execute or forward the call
- AND the hosted audit record MUST reference the decision correlation ID.

### Denied by deterministic check

- GIVEN a tool call matches a local deterministic block rule
- WHEN the local proxy evaluates the call
- THEN it MUST deny the call locally
- AND it MUST NOT call hosted evaluation APIs.

### Denied by hosted backend

- GIVEN local checks pass for a risky tool call
- WHEN hosted evaluation returns `deny`
- THEN the local proxy MUST block execution
- AND it MUST return hosted reasons and next action to the agent.

### Hosted backend unavailable

- GIVEN hosted evaluation is unreachable or times out
- WHEN the agent requests a high-risk or unknown-risk tool call
- THEN the local proxy MUST fail closed
- AND it MUST include outage guidance without executing the call.

### Audit event persistence

- GIVEN hosted evaluation allowed a tool call
- WHEN execution completes or fails
- THEN the local proxy MUST send an audit outcome event
- AND duplicate retries MUST NOT create duplicate audit records.

### LLM evaluation flow

- GIVEN deterministic and risk checks classify a case as ambiguous
- WHEN hosted evaluation invokes the LLM evaluator
- THEN the evaluator MUST return bounded reasoning to the hosted decision flow
- AND the local proxy MUST enforce only the final hosted decision.

## 5. Non-Functional Requirements

- **NFR-001 Latency**: Local deterministic denies SHOULD complete within 50 ms excluding MCP client overhead.
- **NFR-002 Latency**: Hosted tool-call evaluation SHOULD complete within 750 ms excluding LLM evaluation; LLM-backed evaluation SHOULD use a configured timeout.
- **NFR-003 Availability**: Hosted outages MUST degrade to fail-closed behavior for high-risk and unknown-risk operations.
- **NFR-004 Security**: Local-to-hosted requests MUST use revocable credentials and MUST NOT log raw secrets.
- **NFR-005 Security**: Hosted APIs MUST validate authentication, request schema, correlation ID, and policy version before returning an allow decision.
- **NFR-006 Observability**: Every hosted evaluation and execution outcome MUST be traceable by correlation ID across local logs and hosted audit records.
