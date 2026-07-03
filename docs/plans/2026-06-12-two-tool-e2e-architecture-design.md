# Compass Two-Tool E2E Architecture Design

## Problem

Compass currently exposes too much internal workflow through MCP. The client/agent can end up calling guard, approval, payload, and execution steps manually. That makes the product harder to use and weakens the intended guardrail boundary.

The target direction is a simple MCP surface where users ask Compass to transfer or swap, and Compass internally performs validation, policy/risk checks, transaction building, approval handling, execution, audit, and idempotency.

## Findings

### Public MCP Surface

Compass should expose a deliberately small public MCP API:

- `compass_transfer` - guarded end-to-end transfer.
- `compass_swap` - guarded end-to-end token swap.

Read-only helpers may remain only if they improve UX without exposing execution primitives. Examples: quote preview, wallet context, or policy preview. Lower-level tools such as direct execute, direct signing, transaction payload building, and internal simulation should not be public user-facing primitives.

### Approval and Execution

`userConfirmedRisk` or chat-based confirmation is allowed only as a demo/devnet shortcut. It must be explicitly documented as unsafe for production.

Production target:

- Approval happens outside the chat/LLM path, for example Compass dashboard, Telegram approval, mobile app, or wallet-native approval.
- Execution happens through a deterministic non-LLM executor after approval.
- The LLM may explain or request information, but must not be the authority that approves or executes.

Open question for production: how to make approval and execution trustless enough that users are not merely trusting Compass to execute the transaction it claimed it would execute. This may require wallet-native signatures, deterministic action hashes, or on-chain/cryptographic enforcement.

### Guardrail Boundaries

Compass should lock in these internal boundaries:

1. **Policy/risk boundary**
   - Decides risk and authorization only.
   - Does not build, sign, or send transactions.

2. **Transaction builder boundary**
   - Deterministically builds unsigned transfer/swap transactions.
   - Does not perform policy decisions.
   - Does not call LLMs.

3. **Executor adapter boundary**
   - Executes through a non-LLM path.
   - MVP implementation is local devnet signer.
   - Future implementations can wrap external wallets or downstream MCPs.

Follow-up boundaries that need precise contracts: executor adapter contracts, transaction-builder contracts, audit/idempotency semantics, and non-bypassable security invariants.

### Swap and Integrations

Swap architecture still has two important open areas:

- How MCP clients and wallets integrate with the two-tool flow.
- Which token/protocol security checks are required before allowing a swap.

Swap route provider, quote-to-execute binding, and wallet adapters remain implementation decisions, but they should be designed around those integration/security constraints.

## Recommendation

Implement the new architecture in phases:

1. Keep public MCP surface focused on `compass_transfer` and `compass_swap`.
2. Move guard/evaluate/build/execute orchestration behind those tools.
3. Add an explicit `TransactionExecutor` boundary:
   - `LocalSignerExecutor` for devnet MVP.
   - Future `WalletExecutor` or `McpWalletExecutor` for Dynamic, Phantom, or other providers.
4. Treat `userConfirmedRisk` as devnet/demo-only.
5. Design production approval as an out-of-chat flow before execution.

## Open Architecture Questions

- What read-only helper tools, if any, should remain public?
- What exact production approval channel comes first: dashboard, Telegram, wallet-native, or mobile?
- What makes approval/execution verifiable enough that users do not need to blindly trust Compass?
- What is the exact `TransactionExecutor` contract for local signer vs external wallet vs downstream MCP?
- What idempotency key and lifecycle states should be persisted for retries and duplicate prevention?
- Which token-security checks are mandatory before swap execution?
- Should swap use Jupiter first for MVP, or a direct DEX SDK?
