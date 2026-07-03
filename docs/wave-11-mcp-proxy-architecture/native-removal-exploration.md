## Exploration: wave-11-mcp-proxy-architecture native removal

### Current State
Compass is still built around a native MCP server surface. `back/services/mcp/mcpServer.ts` exposes a static `tools/list` sourced from `listMcpTools()` in `mcpToolRegistry.ts`, and `mcpToolCallRouter.ts` routes `tools/call` through a hardcoded switch over Compass-owned tool names. Wave 10 intentionally optimized this native surface around five public tools: three read/preparation helpers plus `compass_transfer` and `compass_swap`.

This means the current architecture is NOT an Agentwall-style firewall yet. It is a native MCP server with internal guardrails, plus Wave 11 docs/specs that currently propose adding proxy behavior on top of the native path instead of replacing it.

### Affected Areas
- `docs/wave-11-mcp-proxy-architecture/exploration.md` — aligned to the pure-proxy decision and records why the hybrid option was rejected.
- `docs/wave-11-mcp-proxy-architecture/proposal.md` — aligned to pure proxy: no native Compass MCP tools in the active Wave 11 surface.
- `docs/wave-11-mcp-proxy-architecture/functional-spec.md` — aligned to one-downstream stdio wrapping, downstream `tools/list` as source of truth, and intercepted `tools/call` enforcement.
- `docs/wave-11-mcp-proxy-architecture/technical-spec.md` — aligned to proxy-only mode and documents removal/retirement of native registry/router/executor paths.
- `docs/wave-10-two-tool-e2e-mcp/*` — defines the native public tool surface that Wave 11 would now supersede as the active MCP architecture.
- `back/services/mcp/mcpServer.ts` — today assumes Compass itself owns the listed tools and tool execution path.
- `back/services/mcp/mcpServerContracts.ts` — list/call contracts assume native tool descriptors and native result envelopes.
- `back/services/mcp/mcpToolRegistry.ts` — static registry is the source of truth for public MCP exposure.
- `back/services/mcp/mcpToolContracts.ts` — contracts are centered on Compass-native tool names, schemas, and result shapes.
- `back/services/mcp/mcpToolCallRouter.ts` — hardcoded router contains nearly all native MCP behavior, including parsing, gateway evaluation, LLM enrichment, payload building, execution, and audit.
- `back/services/mcp/internalExecutor.ts` — exists only to support native `compass_transfer` / internal execution flow.
- `back/services/__tests__/mcpServer.test.ts` — locks exact native list contents and native result mapping.
- `back/services/__tests__/mcpToolRegistry.test.ts` — locks the five-tool Wave 10 public registry.
- `back/services/__tests__/mcpToolCallRouter.test.ts` — heavily tests native tool routing and hidden internal primitives.
- `back/services/__tests__/internalExecutor.test.ts` — only relevant for native transfer execution.
- `scripts/install-opencode-mcp.mjs` — currently installs only a native Compass MCP entry (`npm run mcp:dev`).
- `package.json` / `.opencode/opencode.json` — current runtime/install path is native-server-first, not downstream-proxy-first.

### Approaches
1. **Keep hybrid native + proxy** — preserve Wave 10 tools and add proxy forwarding beside them.
   - Pros: Reuses current implementation; lower short-term rewrite cost.
   - Cons: Directly conflicts with the new architecture decision; keeps registry/router complexity; preserves manual/native logic the team wants to remove.
   - Effort: Medium

2. **Pure stdio MCP firewall/proxy** — remove Compass-native tools from the MCP surface and make Compass a guarded downstream proxy only.
   - Pros: Matches the new product direction; removes the largest source of MCP-specific complexity; avoids dual paths, static registries, and native/manual schema mapping.
   - Cons: Makes Wave 10 native MCP docs/tests obsolete as the active direction; requires a clean interception model for downstream tool classification, policy, and audit.
   - Effort: Medium

### Recommendation
Use **Approach 2**.

Wave 11 should explicitly pivot to a pure Agentwall-style proxy: Compass exposes one stdio MCP server, connects to one downstream stdio MCP server in the first slice, forwards `tools/list` from downstream, intercepts `tools/call`, applies Compass policy/audit/fail-closed behavior, and forwards only when allowed. Do NOT keep `mcpToolRegistry.ts`, `mcpToolCallRouter.ts`, native `compass_transfer` / `compass_swap`, or any manual native tool mapping in the Wave 11 target architecture.

### Risks
- Wave 10 native MCP artifacts are still heavily encoded in tests, docs, and contracts; reviewers could accidentally preserve them unless Wave 11 clearly declares them superseded for MCP architecture.
- Current policy/classification logic is action-specific (`transfer`, `swap`, `sign_and_send_transaction`) rather than proxy-generic; forwarding arbitrary downstream tools will need a smaller, generic interception contract.
- Secret-safe migration is now the critical risk: the installer must wrap existing local MCP entries without copying raw env values.
- Some reusable guardrail modules may still matter as backend policy primitives, but they should not remain exposed through native MCP contracts.

### Ready for Proposal
Yes — tell the user Wave 11 should replace the current hybrid design with a pure stdio proxy/firewall spec: downstream `tools/list` passthrough, `tools/call` interception, fail-closed policy/audit boundary, installer-driven local wrapping, and explicit removal of the native tool registry/router architecture.

## What becomes removable if native tools are eliminated

### Fully removable from the MCP architecture
- `back/services/mcp/mcpToolRegistry.ts`
  - Static `PUBLIC_MCP_TOOLS` and `MCP_TOOL_REGISTRY` exist only to publish Compass-owned tools.
- `back/services/mcp/mcpToolCallRouter.ts`
  - Hardcoded per-tool routing, native parsing, and native helper execution are only needed because Compass is acting as the tool provider.
- `back/services/mcp/internalExecutor.ts`
  - Exists only for native `compass_transfer` execution reuse.
- Native MCP contracts in `back/services/mcp/mcpToolContracts.ts`
  - `MCP_TOOL_NAMES`, `CompassTransferInput`, `CompassSwapInput`, `ExecuteMcpTransferInput`, native result assumptions, and internal-only tool names are all native-tool artifacts.
- Native MCP tests
  - `back/services/__tests__/mcpToolRegistry.test.ts`
  - Native-tool assertions inside `back/services/__tests__/mcpServer.test.ts`
  - Most of `back/services/__tests__/mcpToolCallRouter.test.ts`
  - `back/services/__tests__/internalExecutor.test.ts`

### Likely removable if not reused elsewhere
- Native MCP write-flow glue in `mcpToolCallRouter.ts`:
  - `handleCompassTransfer`
  - `handleCompassSwap`
  - `parseCompassTransferInput`
  - `parseCompassSwapInput`
  - quote/oracle helper tool handlers if Compass stops owning helper tools too
- Native execution support that exists to back MCP transfer execution:
  - `pendingTransactionStore.ts` usage for MCP-built payload lifecycle
  - `buildSolTransferTransactionPayload` dependency from the MCP path
  - signer wiring that only exists for native MCP execution
- LLM advisory path in `mcpToolCallRouter.ts`
  - `resolveLlmConfig`, `evaluateLlmMetadata`, sanitizer usage are currently wired only into native transfer/swap calls, not into a generic proxy boundary.

## What must remain for a pure Agentwall-style proxy/firewall
- `back/services/mcp/mcpServer.ts` as the client-facing stdio MCP boundary.
- `back/services/mcp/loadRepoEnv.ts` so the stdio server can still load runtime env safely.
- Audit/event primitives:
  - `back/services/mcp/mcpAuditSink.ts`
  - `back/services/executionGateway.ts` audit helpers (`createActionCandidate`, `buildAuditEvent`)
  - `back/services/executionGatewayContracts.ts`
- Policy/risk primitives that can be reused generically:
  - `back/services/policy/*`
  - generic classification / decision vocabulary, but simplified away from static native tool-name sets
- Installer/config surface:
  - `scripts/install-opencode-mcp.mjs`
  - `package.json` MCP scripts
  - `.opencode/opencode.json` generated target shape
- New proxy-specific contracts and components will be needed:
  - downstream stdio server config contract
  - downstream MCP client/session lifecycle
  - proxy request dispatcher for `initialize`, safe pass-through methods, `tools/list`, and intercepted `tools/call`
  - generic tool classification/policy overlay model

## What can be simplified versus Wave 10

| Area | Wave 10 / current shape | Pure proxy simplification |
|---|---|---|
| Tool publication | Static registry + exact public allowlist | Downstream `tools/list` is the source of truth |
| Tool execution | Hardcoded switch over Compass tool names | Single intercepted `tools/call` forwarding path |
| Contracts | One large native tool contract set | Small proxy contracts: downstream config, discovered tool, forwarded call, decision envelope |
| Write flows | Custom transfer/swap parsing, payload build, signing, idempotency | No native execution path in MCP firewall slice |
| Tests | Native registry/router/executor matrix | Focus on discovery, interception, block/allow forwarding, fail-closed behavior, config migration |
| Installer | Add Compass alongside current local MCP setup | Wrap one downstream server behind Compass and keep secrets indirect |
| Runtime modes | Native mode + proxy mode | One proxy mode only |

## Wave 10 artifacts that become obsolete or need superseding
- `docs/wave-10-two-tool-e2e-mcp/functional-spec.md`
  - Still valid as historical native-tool work, but obsolete as the active MCP architecture direction.
- `docs/wave-10-two-tool-e2e-mcp/technical-spec.md`
  - Its core decisions (`compass_transfer`, `compass_swap`, internal executor, hidden native primitives) should be treated as superseded for Wave 11 MCP architecture.
- `docs/wave-10-two-tool-e2e-mcp/verify-report.md`
  - Evidence about the exact five-tool public surface becomes historical evidence, not the future-facing contract.
- `docs/wave-10-two-tool-e2e-mcp/task.json`
  - Implementation breakdown remains historical only; it should not drive Wave 11 architecture.

## Wave 11 spec changes applied
- Replaced hybrid wording in current Wave 11 docs with an explicit pure-proxy statement.
- Removed requirements that preserve `compass_transfer` / `compass_swap` in proxy mode.
- Removed native-mode vs proxy-mode dual architecture from the technical spec.
- Removed namespaced/manual/native registry concepts unless needed later for a multi-server future wave.
- Reframed Wave 11 scope to:
  - one client-facing Compass stdio server
  - one downstream stdio MCP server in the first slice
  - transparent downstream `tools/list`
  - policy interception at `tools/call`
  - fail-closed behavior when downstream discovery/classification/policy is unsafe
  - secret-safe installer wrapping without copying credentials
- Add an explicit non-goal: no native Compass MCP tool surface in Wave 11.

## Safe Wave 11 direction
- Build the first Wave 11 spec around **pure stdio proxy first**.
- Intercept **`tools/call` only as the main enforcement point**; keep non-tool passthrough minimal and explicitly safe.
- Avoid a native tool registry, native tool router, or manual per-tool schema mirroring.
- Keep the first slice to **one downstream stdio MCP per proxy process**.
- Treat downstream tool descriptors as downstream-owned; Compass adds policy/audit metadata internally, not manual schema copies.
