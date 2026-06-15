# Wave 11 MCP Proxy Architecture Functional Spec

## Purpose

Wave 11 supersedes the Wave 10 native MCP architecture as Compass's active MCP direction. Compass becomes a pure Agentwall-style stdio MCP firewall/proxy: the AI client connects only to Compass, Compass connects to one downstream stdio MCP server per proxy process, and Compass enforces policy at intercepted downstream `tools/call` requests.

Wave 10 native MCP artifacts remain historical reference only. They MUST NOT define the active Wave 11 MCP tool surface.

## Requirements

### Requirement: Pure Proxy MCP Surface

Compass MUST expose a proxy-only MCP surface with no native Compass MCP tools.

#### Scenario: Client lists Compass tools

- GIVEN Compass is running as the Wave 11 MCP proxy
- WHEN the AI client requests `tools/list`
- THEN Compass MUST NOT expose `compass_transfer`, `compass_swap`, Compass helper tools, hidden internal primitives, or any other native Compass MCP tool
- AND the visible tools MUST come from the wrapped downstream MCP server.

### Requirement: Downstream Tools/List Source Of Truth

The wrapped downstream server's `tools/list` response MUST be the source of truth for public tool descriptors.

#### Scenario: Downstream tools are listed

- GIVEN the downstream server returns a valid `tools/list`
- WHEN the AI client requests Compass `tools/list`
- THEN Compass MUST return the downstream tool descriptors without manual schema duplication
- AND Compass MUST NOT require namespacing or renamed tool descriptors in the first slice.

### Requirement: Downstream Stdio Wrapping

Compass MUST wrap exactly one downstream stdio MCP server per proxy process using command, args, env, and cwd from the original local MCP configuration.

#### Scenario: Wrapped downstream starts

- GIVEN an existing local MCP command with args, env, and cwd
- WHEN Compass starts the proxy
- THEN Compass MUST start the downstream server through stdio using that configuration
- AND MUST keep the downstream server hidden from the AI client.

### Requirement: Tool Call Enforcement Point

All enforcement MUST happen at intercepted downstream `tools/call` requests before forwarding.

#### Scenario: Allowed downstream tool call forwards

- GIVEN a downstream tool call passes Compass classification, policy, approval, and audit checks
- WHEN the AI client calls the tool through Compass
- THEN Compass MUST forward the call to the downstream server
- AND MUST record the decision and downstream outcome for audit.

#### Scenario: Blocked downstream tool call does not forward

- GIVEN Compass denies, cannot classify, cannot evaluate policy, or cannot confirm forwarding safety for a downstream tool call
- WHEN the AI client calls the tool through Compass
- THEN Compass MUST NOT forward the call
- AND MUST return a stable denial reason and suggested next action.

### Requirement: Safe Non-Tool Forwarding

Compass SHOULD forward non-tool MCP methods only when they are explicitly safe and supported by the downstream server.

#### Scenario: Non-tool method is safe

- GIVEN the downstream server supports a non-tool MCP method
- AND Compass classifies the method as safe to forward
- WHEN the AI client invokes that method through Compass
- THEN Compass SHOULD forward it unchanged
- AND MUST NOT bypass `tools/call` enforcement.

### Requirement: Fail-Closed Proxy Behavior

Compass MUST fail closed when downstream connection, capability discovery, tool listing, classification, policy evaluation, approval state, or forwarding safety is unavailable or invalid.

#### Scenario: Downstream unavailable

- GIVEN the downstream server cannot start or disconnects
- WHEN the AI client lists or calls downstream tools
- THEN Compass MUST avoid unsafe execution
- AND MUST return clear operator guidance for restoring the proxy.

### Requirement: Secret-Safe Config Wrapping

Compass MUST wrap local MCP setup without copying secrets into generated files, logs, docs, or dry-run output.

#### Scenario: Existing MCP config is wrapped

- GIVEN an existing MCP server config contains env references or secret-bearing fields
- WHEN Compass generates the proxy configuration
- THEN it MUST preserve indirection to the original configuration where possible
- AND MUST NOT duplicate raw secrets into generated Compass config or output.

### Requirement: Wave 11 Scope Boundaries

Wave 11 MUST limit support to stdio-only wrapping and one downstream server per proxy process.

#### Scenario: Unsupported proxy shape is requested

- GIVEN a request requires multiple downstream servers in one proxy process, remote MCP hosting, or native Compass MCP tools
- WHEN Compass evaluates the request
- THEN Compass MUST reject it as out of scope for Wave 11
- AND SHOULD point operators to the supported stdio proxy model.
