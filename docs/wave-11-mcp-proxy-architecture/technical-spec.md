# Wave 11 MCP Proxy Architecture Technical Spec

## Technical Approach

Wave 11 replaces the hybrid native-plus-proxy design with one pure Agentwall-style stdio MCP firewall/proxy. Compass exposes a client-facing stdio MCP server, starts exactly one downstream stdio MCP server per proxy process, forwards downstream `tools/list` as the public tool surface, and intercepts downstream `tools/call` as the enforcement boundary.

Wave 10 docs remain historical evidence for the previous native MCP architecture. They are superseded for the active MCP direction and MUST NOT drive the Wave 11 implementation.

## Architecture Decisions

| Area | Decision | Rationale |
|---|---|---|
| Runtime shape | Use proxy-only mode. | Removes native/proxy branching and makes Compass a single enforcement boundary. |
| Native tools | Remove the native Compass MCP tool surface. | Wave 11 has no `compass_transfer`, `compass_swap`, native helper tools, native registry, or native router. |
| Tool publication | Treat downstream `tools/list` as the source of truth. | Avoids manual schema duplication, stale static descriptors, and Compass-owned tool mapping. |
| Tool names | Preserve downstream tool names in the first slice. | One downstream per proxy process avoids collision handling and namespacing complexity. |
| Enforcement | Intercept `tools/call`; forward only after policy and audit decisions. | Critical operations cannot execute outside Compass guardrails. |
| Other MCP methods | Forward only methods classified as safe. | Transparent forwarding must not become an execution bypass. |
| Failure model | Fail closed on discovery, classification, policy, approval, audit, or forwarding uncertainty. | Unavailable tooling is safer than unsafe pass-through. |

## Data Flow

```text
AI client
  -> Compass stdio MCP proxy server
     -> tools/list passthrough from downstream
     -> intercepted tools/call policy boundary
        -> downstream stdio MCP client
           -> wrapped downstream MCP server
```

`tools/list` returns downstream descriptors without Compass namespacing, renamed tools, or copied schemas in the first slice.

`tools/call` uses the original downstream tool name and arguments. Compass classifies the call, evaluates policy and approval state, records audit intent, forwards only when allowed, then records the downstream result or failure metadata.

## Removals And Simplifications

Retire the native MCP architecture where it is not reused by the proxy boundary:

| Area | Action |
|---|---|
| `back/services/mcp/mcpToolRegistry.ts` | Delete or retire; downstream `tools/list` replaces the static Compass-owned registry. |
| `back/services/mcp/mcpToolCallRouter.ts` | Delete or retire; a single proxy call interceptor replaces hardcoded native routing. |
| `back/services/mcp/internalExecutor.ts` | Delete or retire; native `compass_transfer` execution is not part of Wave 11. |
| Native MCP contracts | Remove native tool names, native input schemas, native result envelopes, and hidden internal tool contracts unless a proxy contract explicitly reuses a generic primitive. |
| Native MCP tests | Delete or rewrite registry/router/internal-executor assertions as proxy tests when they no longer describe active behavior. |

Reusable policy, risk, audit, provider, and config helpers may remain if they are decoupled from native MCP tool contracts.

## Proxy Components And Contracts

Create small proxy-only contracts separate from native MCP tool contracts:

```ts
export type DownstreamMcpStdioConfig = {
  name: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
};

export type DownstreamMcpTool = {
  name: string;
  descriptor: unknown;
};

export type ProxiedMcpToolCall = {
  toolName: string;
  arguments?: Record<string, unknown>;
};

export type ProxyDecision = {
  outcome: "allow" | "deny";
  reason: string;
  suggestedAction?: string;
};
```

| Component | Responsibility |
|---|---|
| Downstream stdio client | Starts one downstream MCP server, manages lifecycle, requests capabilities, lists tools, and forwards allowed tool calls. |
| Proxy server | Presents the only client-facing stdio MCP server and dispatches MCP requests to proxy behavior. |
| Policy interceptor | Classifies intercepted `tools/call` requests, evaluates policy/approval state, and returns allow/deny decisions before forwarding. |
| Audit logger | Records tool-call intent, policy decision, forwarding outcome, failures, and denial reasons without leaking secrets. |
| Installer wrapper | Rewrites local MCP config so clients call Compass, while Compass starts the original downstream command through preserved indirection. |

## Config Wrapping

The installer should wrap an existing local MCP entry as a Compass proxy command that launches the original downstream command. It must preserve existing env references where possible, redact secret-bearing values in dry-run output, and avoid copying raw secrets into generated files.

Compass remains the only exposed MCP server in the client configuration. The downstream server is started only by the proxy process.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Proxy contracts, fail-closed decisions, safe method classification, and denial responses. | Tests around the policy interceptor and proxy request dispatcher. |
| Integration | Downstream stdio discovery, `tools/list` passthrough, allowed forwarding, and blocked forwarding. | Fake downstream MCP server fixture with `tools/list` and `tools/call`. |
| Regression | Absence of native Compass MCP tools from the Wave 11 surface. | Assert no `compass_transfer`, `compass_swap`, helper tools, or hidden internal primitives are listed or routable. |
| Installer | Secret-safe wrapping, dry-run redaction, backup preservation, and one-downstream config shape. | Temporary config fixtures; assert no secret values are written or logged. |

## Rollout

Wave 11 should replace native MCP mode for the active Compass MCP architecture. The first implementation slice should ship only the proxy-only stdio path with one downstream server per proxy process. Multi-server aggregation, namespacing, remote MCP support, and production approval replacement remain out of scope.

## Risks And Open Questions

- Existing Wave 10 native tests and contracts may cause accidental preservation of native tools unless implementation removes or rewrites them deliberately.
- Generic classification for arbitrary downstream tools must be strict enough to fail closed without recreating a hidden native registry.
- Safe non-tool forwarding needs an explicit allowlist; otherwise non-tool methods could bypass the `tools/call` policy boundary.
- Secret-safe config wrapping is critical because the proxy owns downstream startup and must not duplicate credentials.
