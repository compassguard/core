# Proposal: Wave 11 Pure MCP Proxy Architecture

## Intent

Wave 11 supersedes the Wave 10 native MCP architecture. Compass should stop owning a native MCP tool surface and instead become an Agentwall-style stdio MCP firewall/proxy: the AI client connects only to Compass, Compass starts one downstream stdio MCP server, forwards downstream `tools/list`, and intercepts downstream `tools/call` for policy, approval, audit, and fail-closed behavior.

## Product Value

- Agents keep using existing local MCP tools with minimal workflow change.
- Teams get one enforcement point without manually copying downstream schemas into Compass.
- Compass removes native MCP registry/router complexity and focuses on being the guardrail boundary.

## Scope

### In Scope

- Pure proxy MCP runtime: no native Compass MCP tools in the active Wave 11 surface.
- One downstream stdio MCP server per Compass proxy process.
- Downstream `tools/list` passthrough as the public tool descriptor source of truth.
- Intercepted downstream `tools/call` with Compass classification, policy, approval, audit, and fail-closed behavior before forwarding.
- Secret-safe local MCP config wrapping so the AI client sees Compass and Compass starts the original downstream command.
- Explicit retirement of native registry/router/executor paths from the active MCP architecture.

### Out of Scope

- Multi-server aggregation in one proxy process.
- Namespacing or renaming downstream tools in the first slice.
- Remote/cloud MCP marketplace support.
- Production wallet approval implementation.
- Native `compass_transfer`, `compass_swap`, or helper-tool MCP surface.
- Any execution path that bypasses Compass guardrails.

## Capabilities

### New Capabilities

- `mcp-stdio-proxy`: Run Compass as a client-facing stdio MCP server that wraps one downstream stdio MCP server.
- `mcp-call-interception`: Classify, evaluate, approve/deny, audit, and forward downstream `tools/call` requests.
- `mcp-config-wrapping`: Rewrite local MCP setup so downstream servers run behind Compass without copying secrets.

### Superseded Capabilities

- `two-tool-e2e-mcp`: Wave 10 remains historical evidence, but its native MCP tool surface is superseded as the active architecture.

## Approach

Follow Agentwall's simple adapter model first: create an MCP server toward the AI client, create an MCP client toward the downstream stdio server, mirror supported capabilities, forward `tools/list`, and treat `tools/call` as the single enforcement point. Do not maintain a native tool registry, hardcoded native router, or manual downstream schema mapping.

## Acceptance Criteria

- Compass exposes no native MCP tools in Wave 11 proxy mode.
- A downstream stdio MCP can be wrapped without changing the downstream server.
- `tools/list` returns downstream descriptors without manual schema duplication.
- Every downstream `tools/call` is denied or allowed by Compass before forwarding.
- Downstream startup, discovery, policy, approval, audit, and forwarding failures fail closed.
- Config wrapping preserves secret indirection and redacts dry-run output.

## Risks & Open Questions

| Item | Type | Note |
|---|---|---|
| Secret handling during config wrapping | Risk | Preserve references; do not copy raw env values. |
| Generic policy classification | Risk | Must be strict enough for arbitrary downstream tools without recreating a hidden native registry. |
| Non-tool MCP forwarding | Open question | First slice needs a conservative safe-method allowlist. |
| Wave 10 cleanup boundary | Open question | Decide whether to delete native MCP files immediately or retire them behind docs/tests first. |

## Success Criteria

- [ ] Compass is the single MCP surface presented to the agent.
- [ ] Downstream tools execute only after Compass guardrail decisions.
- [ ] Native Compass MCP tool code is removed or retired from the active architecture.
- [ ] Reviewers can define implementation tasks without preserving hybrid/native behavior.

## Next Phases

1. Task plan: retire native registry/router/executor, introduce proxy contracts/client/interceptor, update installer.
2. Implementation: proxy-only stdio wrapper with fake downstream MCP tests.
3. Verification: prompt-level OpenCode E2E proving downstream calls pass through Compass.
