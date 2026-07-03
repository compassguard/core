# Wave 4 — MCP server and tool boundary technical spec

## Summary

Wave 4 introduces a first-party Compass MCP server boundary around the existing backend core. It should be small, testable, and isolated from legacy chat code.

The server exposes MCP-style `tools/list` and `tools/call` behavior for the initial Compass tools. Internally, calls go through the same primitives already implemented in Waves 1–3:

```txt
MCP client
  -> Compass MCP server
    -> tool registry
    -> classifyToolCall
    -> createActionCandidate
    -> evaluateAction / evaluateTransferGateway
    -> audit event
    -> structured MCP result
```

## Proposed file layout

Use dedicated files and keep types/contracts separate from behavior.

```txt
back/services/mcp/
├── mcpServer.ts              # server/transport wiring, if runtime dependency is added
├── mcpServerContracts.ts     # server handler/dependency contracts
├── mcpToolRegistry.ts        # list of exposed Compass tools
├── mcpToolContracts.ts       # tool definitions, result types, schemas
├── mcpToolCallRouter.ts      # tools/call dispatcher
├── mcpToolResults.ts         # result builders / error builders
└── __tests__/                # optional if tests are colocated later
```

Tests can initially live under `back/services/__tests__/mcpTool*.test.ts` to match current Vitest include.

## Dependency policy

Preferred path:

1. Implement registry/router as pure TypeScript first.
2. Add an MCP SDK/transport only after the pure router tests pass.
3. Keep transport code thin and adapter-like.

The local stdio entrypoint uses `@modelcontextprotocol/sdk` as a direct runtime dependency so Compass can expose spec-compatible `tools/list` and `tools/call` handlers through `Server` + `StdioServerTransport` while keeping transport code thin. The dev command uses `tsx` to run the TypeScript-only local entrypoint without adding a backend build pipeline. Do not add broad upstream MCP passthrough in this wave.

## Tool registry contract

Each tool definition should include:

- stable `name`;
- human description;
- risk class;
- input schema or schema-like validator;
- execution adapter;
- audit metadata policy;
- whether it is read-only, preparation, sensitive execution, signing, or blocked.

Initial registry:

| Tool                        | Backend dependency                    |
| --------------------------- | ------------------------------------- |
| `get_usdc_sol_quote`        | `back/services/priceQuote.ts`         |
| `guarded_transfer_sol`      | `back/services/transferGateway.ts`    |
| `sign_and_send_transaction` | no execution adapter; deny-only entry |

## `tools/list`

`tools/list` should return the registered Compass-controlled tools with safe descriptions and input schemas. It must not expose raw Solana signer tools, legacy chat tools, or direct private-key operations.

## `tools/call`

`tools/call` should:

1. Look up the tool in the registry.
2. Classify the call with `classifyToolCall`.
3. Deny blocked/unknown/signing calls fail-closed.
4. For read/preparation tools, call the safe adapter and audit the decision.
5. For `guarded_transfer_sol`, call `evaluateTransferGateway` and return a structured result:
   - `ALLOW` when policy allows;
   - `REQUIRE_HUMAN_APPROVAL` when policy requires approval;
   - `DENY` when policy or missing evidence blocks;
   - `REQUIRE_ADDITIONAL_CONTEXT` if required fields are missing.
6. Build an audit event using existing audit helpers and redaction rules.

## Result shape

Return a stable shape that can later be mapped to MCP response content:

```ts
type CompassMcpToolResult = {
  ok: boolean;
  decision: CompassDecision;
  toolName: string;
  riskClass: ToolRiskClass;
  reasonCodes: string[];
  message: string;
  data?: unknown;
  approval?: {
    required: boolean;
    metadata?: unknown;
  };
  auditId?: string;
};
```

Keep raw transactions, prompts, private keys, and unredacted upstream payloads out of this shape.

## Audit behavior

For Wave 4, audit may continue to use the existing in-memory sink. Durable audit is explicitly deferred. The important requirement is that every `tools/call` decision produces a structured event or a testable audit-builder invocation.

## Security requirements

- No imports from `legacy/`.
- No direct signing or sending.
- Unknown mutating tools fail closed.
- Missing evidence for sensitive execution fails closed or asks for additional context.
- Tool results must include clear reason codes.
- No secret values are logged or serialized.

## Tests

Minimum backend tests:

1. Registry lists the initial tools and does not list raw signer tools.
2. Quote call returns `ALLOW` with quote data and audit metadata.
3. Transfer call to unknown/high-risk recipient returns `REQUIRE_HUMAN_APPROVAL` with transfer gateway metadata.
4. Direct signing call returns `DENY`.
5. Unknown mutating call returns `DENY` fail-closed.
6. Invalid/missing transfer input returns `REQUIRE_ADDITIONAL_CONTEXT` or structured validation error.
7. No router module imports from `legacy/`.

## Rollout

- Implement pure router/registry first.
- Add transport entrypoint second.
- Keep the server local/dev-only until manual MCP evidence is captured.
- Do not merge upstream MCP compatibility into this wave unless the implementation remains below review budget and test coverage is clear.
