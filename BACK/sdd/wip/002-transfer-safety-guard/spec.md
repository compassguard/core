# 002 - Transfer Safety Guard

## Status
WIP

## Goal

Implement a safety layer for agent-initiated wallet transfers on Solana.

The agent must never create or execute a transfer directly after parsing a natural-language request. Every transfer intent must pass through a deterministic safety pipeline that validates the recipient wallet, user policy, risk signals, and human confirmation requirements.

## Scope

This spec covers transfer intents such as:

```txt
Send 0.1 SOL to this wallet
Transfer 5 USDC to wallet X
Pay wallet X with 1 SOL
```

Supported transfer types for MVP:

```txt
SOL transfer on devnet
SPL token transfer can be designed but not required for first demo
```

## Out of Scope

- Swaps.
- Yield strategies.
- Staking.
- Automatic recurring transfers.
- Custody of private keys.
- Backend-side transaction signing.

## User Story

As a user, I want the agent to help me prepare transfers, but I do not want it to send funds to risky, invalid, sanctioned, or unexpected wallets without explicit confirmation.

## High-Level Flow

```txt
User natural-language intent
→ intent parser detects transfer action
→ backend extracts recipient, token, amount
→ transfer policy validation
→ wallet risk validation
→ decision: ALLOW / WARN / REJECT
→ if ALLOW/WARN, create pending action
→ frontend displays confirmation
→ user confirms with wallet
→ on-chain approval is created through AgentActionGuard
→ transfer is prepared/signed by user wallet
→ action is marked executed
→ audit log is stored
```

## Required Backend Components

### Transfer Intent Parser

Extracts:

```json
{
  "action": "transfer",
  "asset": "SOL",
  "amount": "0.1",
  "recipient": "recipient_pubkey"
}
```

### Transfer Policy Engine

Validates user-configured rules:

```json
{
  "max_transfer_lamports": 1000000000,
  "daily_limit_lamports": 5000000000,
  "allowed_assets": ["SOL"],
  "require_confirmation": true,
  "blocked_recipients": [],
  "allowed_recipients": []
}
```

### Wallet Risk Engine

Runs wallet safety checks before creating any transfer transaction.

Required MVP checks:

```txt
1. Recipient must be valid Solana public key.
2. getAccountInfo must be called when possible.
3. Reject if recipient account is executable=true.
4. Warn if wallet has very low transaction history.
5. Reject if recipient appears in internal blocklist.
6. Reject if OFAC match is found.
7. Reject or warn if GoPlus marks the address as malicious.
8. Reject or warn if Chainabuse has severe reports.
```

### Decision Engine

Returns a structured decision:

```json
{
  "decision": "ALLOW_WITH_CONFIRMATION",
  "risk_level": "low",
  "reasons": [
    "Recipient public key is valid",
    "Recipient is not executable",
    "No OFAC match",
    "Amount is within user policy"
  ],
  "requires_confirmation": true
}
```

Allowed decisions:

```txt
ALLOW_WITH_CONFIRMATION
WARN_WITH_CONFIRMATION
REJECT
```

## Security Rules

### Hard Reject

The backend must reject the transfer if:

```txt
- Recipient public key is invalid.
- Recipient account is executable=true.
- Recipient is in OFAC list.
- Recipient is in user blocklist.
- Amount exceeds max transfer policy.
- Daily limit would be exceeded.
- The action params differ from the pending action hash.
- User did not explicitly confirm.
```

### Warning

The backend should return WARN if:

```txt
- Recipient wallet is very new.
- Recipient has very few transactions.
- Chainabuse has low-confidence reports.
- External risk API is unavailable but not critical.
```

## SSE Contract

When a transfer requires confirmation, the backend must send a normal assistant message over SSE with metadata serialized as a JSON string.

```txt
event: message
data: {
  "type": "assistant_message",
  "content": "I found a transfer request. Please review before signing.",
  "metadata": "{\"requires_confirmation\":true,\"confirmation_id\":\"conf_123\",\"function_tool\":{\"display_name\":\"Transfer SOL\",\"technical_name\":\"transfer_sol\",\"params\":{\"asset\":\"SOL\",\"amount\":\"0.1\",\"recipient\":\"recipient_pubkey\"}},\"risk_level\":\"low\",\"policy_result\":\"allowed_with_confirmation\"}"
}
```

## Pending Action Store

Before sending confirmation to the frontend, backend must persist:

```json
{
  "confirmation_id": "conf_123",
  "conversation_id": "conv_123",
  "action_type": "transfer_sol",
  "action_hash": "sha256_canonical_params",
  "params": {
    "asset": "SOL",
    "amount": "0.1",
    "recipient": "recipient_pubkey"
  },
  "status": "pending",
  "expires_at": "2026-05-09T18:00:00Z"
}
```

## On-Chain Integration

This feature must integrate with the `AgentActionGuard` Solana program.

Before executing the transfer, the user must sign an on-chain approval containing:

```txt
user
agent
action_hash
action_type = TRANSFER_SOL
input_amount
recipient
expires_at
executed=false
revoked=false
```

The backend must verify the on-chain approval exists and matches the pending action before preparing the transfer.

## Acceptance Criteria

- A natural-language transfer intent is parsed correctly.
- Invalid recipient public keys are rejected.
- Executable accounts are rejected.
- Transfers above the user's policy limit are rejected.
- Risk checks produce clear reasons.
- ALLOW/WARN actions require user confirmation.
- REJECT actions never create a transaction.
- The backend stores a pending action with an action hash.
- The user signs an on-chain approval before transfer execution.
- Transfer execution cannot happen if the action hash was modified.
- The action can be marked as executed after successful transfer.

## Demo Cases

### Case 1: Safe Transfer

```txt
User: Send 0.1 SOL to wallet B
Result: ALLOW_WITH_CONFIRMATION
```

### Case 2: Invalid Recipient

```txt
User: Send 0.1 SOL to invalid_wallet
Result: REJECT
```

### Case 3: Amount Too High

```txt
User: Send 10 SOL to wallet B
Policy max: 1 SOL
Result: REJECT
```

### Case 4: New Wallet

```txt
User: Send 0.1 SOL to new wallet
Result: WARN_WITH_CONFIRMATION
```
