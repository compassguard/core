# Proposal: Hybrid Local and Hosted Architecture

## Intent

Compass MCP Guard should move from a monolithic local stdio proxy to a hybrid local and hosted architecture. Wave 11 keeps checks, risk, policy, audit, and optional LLM decisions in one process. That works for a local MVP, but limits persistence, scaling, observability, and separation of concerns. The new architecture keeps local MCP stdio while moving heavy work to a hosted backend.

## Product Value

- Agents keep the same local MCP stdio workflow.
- Audit becomes durable.
- Risk, policy, and LLM logic can evolve independently.

## Architecture Decisions

| Decision | Rationale |
|---|---|
| Keep local MCP stdio | Preserves compatibility. |
| Remove downstream MCP | Compass becomes the MCP server and enforcement boundary. |
| Run deterministic checks locally | Fast denies should not pay network latency. |
| Move heavy evaluation to HTTP | Risk, audit, and LLM decisions need separate deployment. |
| Use Hono/Bun on Vercel | Starts with low operational ceremony. |

## Current vs Proposed

| Area | Current Wave 11 | Proposed Hybrid |
|---|---|---|
| MCP boundary | Local stdio proxy | Local stdio MCP server |
| Downstream MCP | Required | Removed |
| Risk engine | Local heuristics | Local checks plus hosted engine |
| Policy | Local evaluation | Hosted evaluation |
| Audit | In-memory or local-only | Persistent hosted audit log |
| LLM evaluation | Optional local router/decision | Hosted router and decision judge |
| Deployment | Single process | Local proxy plus hosted backend |

## Scope

### In Scope

- HTTP API contract between local proxy and hosted backend.
- Hosted backend skeleton for risk, policy, audit, and LLM endpoints.
- Local proxy refactor for checks, HTTP client, and fail-closed behavior.

### Out of Scope

- On-chain persistence.
- Full audit dashboard.
- Multi-tenant organization model.

## Components and Responsibilities

| Component | Responsibilities |
|---|---|
| Local MCP Proxy | Expose MCP stdio, normalize calls, run checks, call HTTP, enforce. |
| Hosted Backend | Serve evaluation, audit, LLM, and health endpoints. |
| Risk Engine | Analyze destinations, tokens, protocols, amounts, and behavior. |
| LLM Evaluator | Judge ambiguous cases deterministic rules cannot classify. |
| Audit Store | Persist requests, decisions, reasons, versions, and correlation IDs. |

## API Contract Sketch

```http
GET /health
POST /v1/evaluations/tool-call
POST /v1/audit/events
POST /v1/llm/evaluate
```

`POST /v1/evaluations/tool-call` accepts tool name, arguments, agent context, local findings, and correlation ID. It returns `allow`, `deny`, or `confirm`, with reasons, risk level, and audit reference.

## Risks and Open Questions

| Item | Concern |
|---|---|
| Latency | Hosted evaluation adds network cost. |
| Auth | Local-to-hosted auth needs revocable credentials that do not leak. |
| Failure modes | Backend outages must fail closed for risky actions. |
| Vercel limitations | Long LLM calls or background audit work may require queues or another runtime. |

## Success Criteria

- Local proxy remains the only MCP server exposed to agents.
- No critical operation executes without local checks and hosted policy.
- Hosted audit persists every evaluated tool call with reasons and correlation IDs.
- Backend outages are tested and fail-closed for high-risk operations.
