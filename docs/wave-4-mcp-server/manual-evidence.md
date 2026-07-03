# Wave 4 manual MCP evidence

This runbook verifies the local Compass MCP stdio server after T5/T6. It exercises the three MVP outcomes through real MCP `tools/list` and `tools/call` requests.

## Quick path

Run from the repo root:

```bash
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npm',
  args: ['run', '--silent', 'mcp:dev'],
});
const client = new Client(
  { name: 'compass-wave4-manual-evidence', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

function summary(result) {
  const structured = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
  return {
    ok: structured.ok,
    decision: structured.decision,
    toolName: structured.toolName,
    riskClass: structured.riskClass,
    reasonCodes: structured.reasonCodes,
    auditId: structured.auditId,
    hasData: Boolean(structured.data),
    approvalRequired: structured.approval?.required,
  };
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const quote = await client.callTool({
    name: 'get_usdc_sol_quote',
    arguments: {
      network: 'devnet',
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 10,
      slippage_bps: 100,
    },
  });
  const transfer = await client.callTool({
    name: 'guarded_transfer_sol',
    arguments: {
      network: 'devnet',
      actorWallet: 'manual-actor-wallet',
      amountSol: 1,
      recipientAddress: 'manual-unknown-recipient',
      recipientKnown: false,
      walletSafety: { status: 'unknown' },
    },
  });
  const deny = await client.callTool({
    name: 'sign_and_send_transaction',
    arguments: { rawTransaction: 'must-not-leak' },
  });

  console.log(JSON.stringify({
    tools: tools.tools.map((tool) => ({
      name: tool.name,
      readOnlyHint: tool.annotations?.readOnlyHint,
      riskClass: tool._meta?.riskClass,
    })),
    quote: summary(quote),
    transfer: summary(transfer),
    deny: summary(deny),
    rawTransactionLeaked: JSON.stringify(deny).includes('must-not-leak'),
  }, null, 2));
} finally {
  await client.close();
}
NODE
```

## Expected result

| Check               | Expected                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| `tools/list`        | Exactly `get_usdc_sol_quote`, `guarded_transfer_sol`, `sign_and_send_transaction`   |
| Quote call          | `ALLOW`, `READ_ONLY`, audit id present                                              |
| Transfer call       | `REQUIRE_HUMAN_APPROVAL`, `SENSITIVE_EXECUTION`, approval metadata/audit id present |
| Direct signing call | `DENY`, `SIGNING`, `DIRECT_SIGN_AND_SEND_BLOCKED`, audit id present                 |
| Sentinel safety     | `rawTransactionLeaked: false`                                                       |

## Captured output

Captured on `2026-06-09` from `feature/wave-4-mcp-server`:

```json
{
  "tools": [
    {
      "name": "get_usdc_sol_quote",
      "readOnlyHint": true,
      "riskClass": "READ_ONLY"
    },
    {
      "name": "guarded_transfer_sol",
      "readOnlyHint": false,
      "riskClass": "SENSITIVE_EXECUTION"
    },
    {
      "name": "sign_and_send_transaction",
      "readOnlyHint": false,
      "riskClass": "SIGNING"
    }
  ],
  "quote": {
    "ok": true,
    "decision": "ALLOW",
    "toolName": "get_usdc_sol_quote",
    "riskClass": "READ_ONLY",
    "reasonCodes": ["KNOWN_READ_ONLY_TOOL"],
    "auditId": "475b425c-8aa7-4b66-8233-f092404c17cc",
    "hasData": true
  },
  "transfer": {
    "ok": false,
    "decision": "REQUIRE_HUMAN_APPROVAL",
    "toolName": "guarded_transfer_sol",
    "riskClass": "SENSITIVE_EXECUTION",
    "reasonCodes": ["TRANSFER_EXCEEDS_LIMIT"],
    "auditId": "53ed2222-602d-4e9f-bb76-9778d759ccc1",
    "hasData": true,
    "approvalRequired": true
  },
  "deny": {
    "ok": false,
    "decision": "DENY",
    "toolName": "sign_and_send_transaction",
    "riskClass": "SIGNING",
    "reasonCodes": ["DIRECT_SIGN_AND_SEND_BLOCKED"],
    "auditId": "3a9ba270-d1c9-4a00-9104-aab596c54543",
    "hasData": false
  },
  "rawTransactionLeaked": false
}
```

## Notes

- `npm run mcp:dev` starts a local stdio MCP server through `tsx back/services/mcp/mcpServer.ts`.
- The transfer outcome depends on SOL→USDC quote evidence; the router supplies `quoteUsd` to `evaluateTransferGateway` so the policy can decide approval vs missing context.
- Durable audit storage is still out of scope for Wave 4; audit ids refer to the current in-memory sink.
