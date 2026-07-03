# Wave 9 - LLM decision, MCP setup, and devnet hardening — technical spec

Wave 9 implements a bounded LLM judge, an OpenCode MCP installer, and devnet-focused hardening (signer env alias, public-key validation, approvalProof bypass, default actorWallet, recipientKnown default, transfer payload builder) without changing Compass deterministic guarantees for mainnet.

## Architecture

```txt
MCP tool call
  -> classify tool
  -> deterministic policy/gateway evaluation
  -> sanitized LLM judge input (optional/default-off)
  -> schema-validated LLM recommendation
  -> decision clamp
  -> audit metadata
```

Decision clamp rules:

| Deterministic decision | LLM may keep | LLM may tighten | LLM may loosen |
| --- | --- | --- | --- |
| `ALLOW` | Yes | `REQUIRE_HUMAN_APPROVAL` or `DENY` | No |
| `REQUIRE_HUMAN_APPROVAL` | Yes | `DENY` | No |
| `REQUIRE_ADDITIONAL_CONTEXT` | Yes | `DENY` | No |
| `DENY` | Yes | N/A | No |

## Proposed Files

| File | Role |
| --- | --- |
| `back/services/llmDecisionContracts.ts` | LLM judge input/output types and decision schema. |
| `back/services/llmDecisionAdapter.ts` | Provider adapter, timeout, schema validation, default-off config. |
| `back/services/llmDecisionSanitizer.ts` | Redacts raw prompts, tx bytes, private keys, secrets, and oversized values. |
| `back/services/mcp/mcpToolCallRouter.ts` | LLM metadata enrichment, default actorWallet, recipientKnown default, approvalProof bypass guarded by pending payload validation, devnetApprovalBypassed audit flag. |
| `back/services/mcp/loadRepoEnv.ts` | Minimal repo-root .env loader for MCP stdio startup (no dotenv dependency). |
| `back/services/pendingTransactionStore.ts` | In-memory pending payload store used to ensure devnet proof bypass only signs Compass-built payloads. |
| `back/services/signerAdapter.ts` | Accepts COMPASS_LOCAL_SIGNER_SECRET_KEY alias and validates COMPASS_LOCAL_SIGNER_PUBLIC_KEY. |
| `back/services/signerAdapterContracts.ts` | Extended with LOCAL_SIGNER_PUBLIC_KEY_MISMATCH error reason. |
| `back/services/transferTransactionPayload.ts` | Builds unsigned VersionedTransaction payloads for devnet SOL transfers. |
| `back/services/transferTransactionPayloadTypes.ts` | Types for transfer payload builder input/result. |
| `back/services/mcp/mcpToolContracts.ts` | approvalProof is optional; ExecuteApprovedActionInput updated. |
| `back/services/mcp/mcpToolRegistry.ts` | Schema updates: actorWallet optional, recipientKnown description, approvalProof optional on devnet. |
| `scripts/install-opencode-mcp.mjs` | Idempotent OpenCode MCP config installer. |
| `package.json` | Adds `mcp:install:opencode` script. |
| `.env.example` | Root env example with COMPASS_LLM_* and signer vars. |

## Devnet Hardening

### Signer Environment Alias and Public-Key Validation

The local signer adapter now accepts two env vars for the base58 secret key:

| Variable | Purpose |
| --- | --- |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` | Original base58 secret key (unchanged). |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY` | Alias — identical base58 secret key under a shorter name. |

Resolution tries `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` first, then `COMPASS_LOCAL_SIGNER_SECRET_KEY`.

When `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` is also set, the adapter verifies that the derived keypair address matches. If they differ, `createSignerAdapter` returns `{ ok: false, reason: "LOCAL_SIGNER_PUBLIC_KEY_MISMATCH" }`. This prevents misconfigured signers from silently using the wrong key.

### Devnet-Only approvalProof Bypass

`execute_approved_action` now makes `approvalProof` optional in its input schema. On `devnet`, omitting `approvalProof` skips on-chain verification only when the submitted payload matches an entry previously recorded by Compass in `pendingTransactionStore`. Arbitrary devnet payloads are denied before signer lookup. Successful bypasses set `devnetApprovalBypassed: true` in audit events. On `testnet` and `mainnet-beta`, `approvalProof` is still required; omitting it returns `REQUIRE_ADDITIONAL_CONTEXT` with `MISSING_APPROVAL_PROOF`.

The audit sink tracks `devnetApprovalBypassed` in every `execute_approved_action` audit event.

### Default actorWallet from Local Signer

When `actorWallet` is omitted in a tool call, the router resolves it from the local signer adapter (`createSignerAdapter().adapter.getAddress()`). The resolved wallet is passed to gateway evaluation and the transfer payload builder. If the signer is unavailable, the original input (without `actorWallet`) is passed through — gateways handle the missing field per their own rules.

This applies to `guarded_transfer_sol`, `guarded_swap`, and `guarded_conditional` tool calls.

### recipientKnown Defaults to false

When `recipientKnown` is omitted in a transfer call, it defaults to `false` (unknown recipient). This ensures conservative risk classification when the agent does not explicitly confirm recipient trust.

### Devnet Transfer Transaction Payload Builder

`buildSolTransferTransactionPayload` constructs an unsigned `VersionedTransaction` for SOL transfers on devnet. It fetches a recent blockhash, builds a `SystemProgram.transfer` instruction, and returns a base64-encoded payload ready for `execute_approved_action`.

Non-devnet networks return `TRANSFER_PAYLOAD_UNSUPPORTED_NETWORK`. The transfer result now includes `executionPayload` (with the unsigned transaction) when the decision is `ALLOW` or `REQUIRE_HUMAN_APPROVAL` and `actorWallet` is resolved. When the payload builder fails, the result includes `executionPayloadStatus: "unavailable"` with a reason.

## LLM Judge Contract

Input MUST include only:

- tool name, action kind, network, deterministic decision;
- risk class and reason codes;
- policy id, evaluated rules, bounded metadata summaries;
- simulation/risk summaries when available.

Output MUST validate as:

```ts
type LlmGuardDecision = {
  decision: "ALLOW" | "REQUIRE_HUMAN_APPROVAL" | "REQUIRE_ADDITIONAL_CONTEXT" | "DENY";
  confidence: number;
  reasonCodes: string[];
  rationale: string;
};
```

Invalid output MUST be ignored. Timeouts MUST preserve deterministic behavior.

## Config

Recommended environment names:

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMPASS_LLM_DECISION_ENABLED` | Enables judge calls. | `false` |
| `COMPASS_LLM_PROVIDER` | Provider key. | `opencode-go` |
| `COMPASS_LLM_MODEL` | Model name. | `kimi-k2.5` |
| `COMPASS_LLM_BASE_URL` | OpenCode Go chat completions endpoint. | `https://opencode.ai/zen/go/v1/chat/completions` |
| `COMPASS_LLM_API_KEY` | Optional provider credential. | unset |
| `COMPASS_LLM_TIMEOUT_MS` | Judge timeout. | `3000` |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY` | Base58 secret key alias for local signer. | unset |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` | Base58 secret key (original). | unset |
| `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` | Expected public key; signer fails if mismatch. | unset |

## OpenCode Installer

The installer MUST update `.opencode/opencode.json` with this shape:

```json
{
  "mcp": {
    "compass": {
      "type": "local",
      "command": ["npm", "run", "--silent", "mcp:dev"],
      "enabled": true,
      "env": {}
    }
  }
}
```

Installer requirements:

- preserve `$schema`, `instructions`, and unrelated config;
- support `--dry-run`;
- create a timestamped backup before writing;
- never write API keys, signer secrets, or wallet keys;
- print restart instructions because OpenCode does not hot-reload config.

## Verification

- Focused tests for LLM decision clamp, sanitizer, invalid output fallback, and timeout fallback.
- Focused tests for installer dry-run/idempotency/preserve-existing-config behavior.
- Focused tests for signer env alias, public-key validation, devnet approvalProof bypass, default actorWallet, recipientKnown default, and transfer payload builder.
- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`

Current evidence: 245/245 backend tests pass, tsc clean, 0 lint errors (1 pre-existing warning).
