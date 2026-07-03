# Wave 9 - LLM decision, MCP setup, and devnet hardening exploration

## Current State

Compass currently exposes a local stdio MCP server through `back/services/mcp/mcpServer.ts` and routes all tool calls through deterministic guardrails in `mcpToolCallRouter.ts`, `executionGateway.ts`, `policyEngine.ts`, and the transfer/swap/conditional gateways. The MCP surface already fails closed for unknown mutating tools and direct signing.

Wave 7 added approved execution hardening. Wave 8 added a local demo runbook. No active LLM decision module existed in `back/services`, although `@langchain/core`, `@langchain/langgraph`, and `@langchain/openai` are already dependencies.

The sibling `security_agent_middleware` architecture uses a proxy cascade:

```txt
client/agent -> normalized request -> deterministic checks -> optional judge -> enforcement -> upstream
```

Reusable patterns from that repo:

- Run cheap deterministic checks before an LLM judge.
- Treat the judge as schema-validated and bounded, not as executor.
- Support explicit provider config, timeouts, and fallback behavior.
- Provide idempotent setup scripts with `--dry-run`, backups, and no secret logging.

## Affed Areas

- `back/services/mcp/mcpToolCallRouter.ts` - LLM metadata enrichment, default actorWallet from local signer, recipientKnown default, approvalProof bypass on devnet guarded by pending payload validation, transfer payload builder integration, devnetApprovalBypassed audit flag.
- `back/services/pendingTransactionStore.ts` - in-memory store for Compass-built transaction payloads accepted by the devnet proof bypass.
- `back/services/mcp/mcpToolContracts.ts` - approvalProof made optional for devnet demo execution.
- `back/services/mcp/mcpToolRegistry.ts` - Schema updates: actorWallet description, recipientKnown description and default false, approvalProof optional on devnet.
- `back/services/llmDecision*` - New contracts/adapter boundary for advisory LLM judge.
- `back/services/signerAdapter.ts` - Accepts COMPASS_LOCAL_SIGNER_SECRET_KEY alias, validates COMPASS_LOCAL_SIGNER_PUBLIC_KEY.
- `back/services/transferTransactionPayload.ts` - Devnet transfer payload builder.
- `back/services/mcp/loadRepoEnv.ts` - Minimal .env loader for MCP stdio startup.
- `.opencode/opencode.json` - Target config shape for local MCP setup.
- `scripts/` and `package.json` - MCP install script and npm alias.

## Approaches

1. **Advisory LLM Judge After Policy** - Deterministic policy runs first; LLM can add explanation, risk tags, or require approval within policy bounds.
   - Pros: Safe, incremental, testable, aligns with `security_agent_middleware` cascade.
   - Cons: Does not fully automate every decision yet.
   - Effort: Medium.

2. **LLM as Policy Engine Replacement** - Send tool calls directly to LLM and use model output as final decision.
   - Pros: Fast demo narrative.
   - Cons: Unsafe for on-chain execution, prompt-injection prone, hard to audit.
   - Effort: Medium but high risk.

3. **MCP Setup Script Only** - Add OpenCode setup first and defer LLM.
   - Pros: Low risk, improves demo usability.
   - Cons: Does not satisfy automatic decision requirement.
   - Effort: Low.

## Recommendation

Use approach 1 plus the setup script. Add a default-off LLM judge boundary with strict schema, timeout, sanitized payload, and deterministic fallback. In parallel, add a secret-safe OpenCode MCP installer that writes/updates `.opencode/opencode.json` with a local MCP server command equivalent to `npm run mcp:dev`.

## Risks

- LLM must not turn a deterministic `DENY` into `ALLOW`.
- Raw prompts, secrets, private keys, or unsigned transaction bytes must never be sent to the model.
- LLM timeouts or invalid JSON must not block safe fallback.
- OpenCode config writes must be idempotent and preserve unrelated config.
- Mainnet/custody readiness must not be implied.

## Ready for Specs

Yes. Specs cover six capabilities in Wave 9: LLM-assisted guardrail decisions, OpenCode MCP setup, signer env alias + public-key validation, devnet approvalProof bypass, default actorWallet + recipientKnown default, and devnet transfer payload builder.
