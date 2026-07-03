# Proposal: Debug Logging Utility

## Intent

Zero structured debug logging exists today. Debugging a policy denial or routing decision requires adding ad-hoc `console.log`, re-running, and removing. The MCP protocol owns stdout for JSON-RPC, so any debug output must use stderr — but there's no shared utility for it. This adds friction to every investigation and leaves silent gaps in catch blocks.

## Scope

### In Scope
- Single `debugLogger.ts` file with a `debug(module, message, data?)` function writing to stderr
- `COMPASS_DEBUG` env var toggle with module-level filtering (comma-separated)
- Stderr-only output: `[timestamp] [module:function] message [data]`
- Redaction of sensitive fields reusing existing `redactSecretArguments()` patterns
- Migration of 5 existing `console.log/error` calls to the debug logger

### Out of Scope
- Log levels (info/warn/error/fatal) — single debug toggle covers first needs
- File rotation, log shipping, or persistent log storage
- Structured JSON logging or log aggregation integration
- Performance tracing or span-based observability

## Capabilities

### New Capabilities
- `debug-logging`: Structured stderr-based debug logging with module filtering, timestamp, and sensitive-data redaction for Compass MCP Guard services.

### Modified Capabilities
None — this is a new utility, no existing spec changes.

## Approach

One file, zero dependencies. `debugLogger.ts` exports a single `debug()` function and a `setDebugModules()` configurator. The function checks `COMPASS_DEBUG` env var at call time, matches the caller's module against the allowlist, formats `[timestamp] [module:function] message [data]` with redacted data, and writes to `process.stderr.write()`.

Module naming convention: `proxy`, `policy`, `gateway`, `execution`, `interceptor`, `llm`, `signer`, `connection`, `audit`.

Redaction reuses the existing `SENSITIVE_KEY_PATTERN` regex from `executionGateway.ts` — no need to import it, just a shared utility pattern. Each call site passes an optional redact function or relies on the default key-pattern redaction.

Insertion priority: (1) `mcpProxyDispatcher.ts` — full decision flow, (2) `executionGateway.ts` — classification and candidate creation, (3) `policyEngine.ts` — which rule matched, (4) `policyEvaluationResult.ts` — decision mapping, (5) `mcpProxyPolicyInterceptor.ts` — token matching, (6) domain gateways — transfer, swap, conditional, (7) existing 5 `console.log/error` sites.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `back/services/guardrail/debugLogger.ts` | New | Single debug utility, one exported function |
| `back/services/mcp/proxy/mcpProxyDispatcher.ts` | Modified | Add debug calls at each decision gate |
| `back/services/guardrail/execution/executionGateway.ts` | Modified | Add debug calls for classification paths |
| `back/services/guardrail/policy/policyEngine.ts` | Modified | Add debug calls per rule evaluation |
| `back/services/guardrail/policy/policyEvaluationResult.ts` | Modified | Add debug call on decision mapping |
| `back/services/mcp/proxy/mcpProxyPolicyInterceptor.ts` | Modified | Add debug calls per risk class match |
| `back/services/domains/transfer/transferGateway.ts` | Modified | Add debug calls |
| `back/services/domains/swap/swapGateway.ts` | Modified | Add debug calls |
| `back/services/domains/conditional-parking-lot/conditionalGateway.ts` | Modified | Add debug calls |
| `back/services/mcp/server/mcpServer.ts` | Modified | Migrate existing console.error |
| `back/services/mcp/config/loadRepoEnv.ts` | Modified | Migrate existing console.error |
| `back/services/solana/providers/solanaConnection.ts` | Modified | Migrate existing console.log |
| `back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts` | Modified | Migrate existing console.error |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Debug output leaks sensitive data to stderr | Low | Default redaction on data arg; caller explicitly opts into raw output |
| COMPASS_DEBUG parsing edge cases (empty string, whitespace, wildcards) | Low | Single `split(",").map(s => s.trim()).filter(Boolean)` — no wildcards in first slice |
| Performance overhead on every tool call | Low | Single env-var check + Set.has() per call; negligible |

## Rollback Plan

Remove `debug()` calls from each file (one commit) and delete `debugLogger.ts`. No schema changes, no data migration, no state to revert.

## Dependencies

None. Zero external dependencies. Uses `process.stderr.write()` from Node.js stdlib.

## Success Criteria

- [ ] Setting `COMPASS_DEBUG=proxy,policy` enables debug output only for those modules
- [ ] Unsetting `COMPASS_DEBUG` or setting to empty produces zero stderr output
- [ ] All 5 existing `console.log/error` calls migrated to the debug logger
- [ ] Sensitive fields (keys, secrets, passwords, tokens) redacted before output
- [ ] Debug output never appears on stdout (verified by test capturing stdout vs stderr)