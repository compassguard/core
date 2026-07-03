# Wave 10 Proposal - Two-Tool E2E MCP Surface

## Decision

Compass MCP should stop exposing internal guardrail/simulation/execution steps as user-facing tools. The public MCP surface should expose tools that are useful to an agent/user directly, while Compass keeps safety orchestration internal.

## Goal

Move Compass toward a simple end-to-end MCP UX:

- `compass_transfer` - guarded transfer flow.
- `compass_swap` - guarded swap flow.
- Read-only helper tools may remain public when they provide user value and do not expose sensitive/non-public data.

Compass should internally run validation, policy/risk checks, transaction building, demo approval handling, local execution, audit, and idempotency.

## Current Problems

| Problem | Impact |
|---|---|
| Too many public MCP tools | Agents see internal implementation steps and can misuse or overthink them. |
| Guard then execute is a client workflow | The agent must carry `candidateId` and `transactionPayload` between calls. |
| Simulation/security tools are public | Safety internals leak into the MCP UX instead of staying inside Compass. |
| Transfer is almost E2E but split | The system can build and execute devnet transfers, but not through one user-facing tool. |
| Swap is not E2E | Swap currently evaluates policy but does not build or execute a transaction. |

## Scope

### In Scope

- Define the public MCP surface around user-value tools.
- Keep read-only helpers public if they are safe and useful, such as quote or balance tools.
- Hide low-level safety/simulation/execution tools from the public MCP list.
- Introduce a single-call transfer flow for devnet/local-signer MVP.
- Preserve existing deterministic policy/risk checks.
- Add demo-only approval behavior:
  - If `network === "devnet"` and `userConfirmedRisk === true`, continue.
  - If not devnet, block until production external approval exists.
- Keep production approval/execution outside chat as a TODO, not a fake implementation.

### Out of Scope

- Production approval channel implementation.
- Trustless approval/execution enforcement.
- External wallet/MCP executor adapters.
- Full production swap execution.
- Persisted audit/idempotency store.

## Target MCP Surface

### Public Write Tools

| Tool | Purpose |
|---|---|
| `compass_transfer` | Transfer SOL/SPL tokens through Compass guardrails and configured executor. |
| `compass_swap` | Swap tokens through Compass guardrails and configured executor. |

### Public Read-Only Helpers

Read-only tools are allowed if they do not return private/sensitive data.

Candidates to keep public:

- quote tools
- token price tools
- wallet balance tools
- policy/risk preview tools only if they do not expose internal bypass details

### Internal-Only Tools / Capabilities

These should not remain public MCP tools:

- direct signing
- `execute_approved_action`
- raw simulation tools
- internal transaction payload builders
- approval proof handlers
- low-level guard/evaluate-only tools when replaced by E2E action tools

## Target Transfer Flow

```text
agent calls compass_transfer
  -> parse input
  -> default source wallet from local signer in demo mode
  -> run transfer policy/risk checks
  -> if DENY: return clear denial
  -> if REQUIRE_ADDITIONAL_CONTEXT: return missing fields/context
  -> if REQUIRE_HUMAN_APPROVAL:
       devnet + userConfirmedRisk=true -> continue
       non-devnet -> block with production approval TODO message
       devnet without confirmation -> ask for confirmation
  -> build unsigned transfer transaction internally
  -> execute through local signer in MVP
  -> audit and return signature
```

## Target Swap Flow

```text
agent calls compass_swap
  -> parse input
  -> run quote/token/protocol/slippage checks using current swap policy
  -> if DENY/context/approval: return clear result
  -> if allowed in MVP path: continue only where currently supported
  -> future: build swap transaction and execute through executor boundary
```

For now, swap should keep using the current provider/check model until a dedicated swap execution wave defines the builder.

## Safety Requirements

- LLM output must never approve or execute transactions.
- `userConfirmedRisk` is demo/devnet-only and must be blocked outside devnet.
- Production approval must happen outside chat, such as Compass dashboard, Telegram, mobile, or wallet-native approval.
- Transaction builders must be deterministic and must not decide policy.
- Executors must be non-LLM adapters.
- Direct signing/sending must remain unavailable as public MCP capability.

## Open TODOs

- Define production approval channel.
- Define trustless/verifiable approval-to-execution binding.
- Define executor adapter contract for Dynamic, Phantom, downstream MCPs, or other wallets.
- Define persisted audit/idempotency lifecycle.
- Define mandatory token-security checks for production swaps.
- Decide whether swap execution uses Jupiter first or direct DEX SDK later.

## Acceptance Criteria

- Public MCP tool list is easy for an agent to understand.
- Transfer can be requested through one user-facing tool.
- Internal guardrails still run before execution.
- Devnet demo can proceed with explicit `userConfirmedRisk`.
- Non-devnet execution blocks with a clear external-approval-required message.
- Read-only helper tools stay safe and do not expose sensitive data.
