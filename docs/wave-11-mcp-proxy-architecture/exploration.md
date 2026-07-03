## Exploration: wave-11-mcp-proxy-architecture

### Current State

Compass currently exposes a native stdio MCP server from `.opencode/opencode.json` via `npm run mcp:dev`. The active public tool list is static (`mcpToolRegistry.ts`), and calls route through hardcoded native logic (`mcpToolCallRouter.ts`). Wave 10 proved a two-tool native surface, but the new Wave 11 direction deliberately supersedes that architecture.

Agentwall's MCP adapter is much simpler: it acts as an MCP server toward the AI client and as an MCP client toward one real downstream stdio MCP server. It forwards `tools/list` from the downstream server, intercepts `tools/call` for policy/approval/audit, and forwards only allowed calls. It does not manually re-register downstream schemas.

### Affected Areas

- `back/services/mcp/mcpServer.ts` — becomes the client-facing proxy server boundary.
- `back/services/mcp/mcpToolRegistry.ts` — native static registry should be removed or retired.
- `back/services/mcp/mcpToolCallRouter.ts` — native hardcoded router should be replaced by a generic intercepted forwarding path.
- `back/services/mcp/internalExecutor.ts` — native transfer execution path should be removed or retired from MCP architecture.
- `back/services/mcp/mcpToolContracts.ts` — native tool contracts should be replaced by proxy-focused contracts.
- `back/services/__tests__/mcp*.test.ts` — native registry/router/executor tests should become proxy discovery/interception/fail-closed tests.
- `scripts/install-opencode-mcp.mjs` — should wrap existing local MCP entries behind Compass without copying secrets.
- `.opencode/opencode.json` / `package.json` — should support proxy mode as the active MCP runtime.
- `docs/wave-10-two-tool-e2e-mcp/*` — becomes historical evidence, not the future MCP contract.

### Approaches

1. **Hybrid native + proxy** — Keep Wave 10 native tools and add downstream proxying beside them.
   - Pros: Reuses current code.
   - Cons: Preserves the exact complexity we want to delete; keeps manual registry/router/schema mapping alive.
   - Effort: Medium

2. **Pure stdio proxy** — Remove native Compass MCP tools and make Compass a transparent guarded proxy for one downstream stdio MCP per process.
   - Pros: Closest to Agentwall; simplest mental model; no duplicated downstream schemas; one enforcement point.
   - Cons: Supersedes Wave 10 native code/tests and requires generic policy classification.
   - Effort: Medium

### Recommendation

Use **Approach 2**.

Wave 11 should target a pure Agentwall-style proxy: one client-facing Compass MCP server, one downstream stdio MCP client, downstream `tools/list` passthrough, intercepted `tools/call`, fail-closed policy/audit, and secret-safe config wrapping. Do not keep `compass_transfer`, `compass_swap`, native helper tools, static registries, or hardcoded native routers in the target architecture.

### Risks

- Wave 10 native docs/tests may accidentally pull the design back toward a hybrid architecture unless explicitly marked historical.
- Generic classification for arbitrary downstream calls must avoid becoming a new hidden manual registry.
- Installer wrapping is high risk because it must preserve secret indirection and avoid printing raw env values.
- Safe non-tool forwarding needs an explicit allowlist to avoid bypassing `tools/call` enforcement.

### Ready for Proposal

Yes — the proposal/specs should describe Wave 11 as a pure stdio MCP firewall/proxy that supersedes the native Wave 10 MCP tool surface.
