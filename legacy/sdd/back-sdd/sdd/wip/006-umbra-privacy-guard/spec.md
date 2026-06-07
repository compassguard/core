# 006 - Umbra Privacy Guard

## Status
WIP

## Goal

Add a privacy-oriented feature that demonstrates how private or confidential transfers can still pass through the same agent safety framework.

The MVP does not need to fully integrate Umbra execution. It should be designed as Umbra-ready and show how private actions are approved and audited using commitments instead of exposing all action details on-chain.

## Product Principle

Privacy must not bypass safety.

Private agent actions must still pass:

```txt
- policy checks
- wallet risk checks
- user confirmation
- on-chain approval
- expiration
- anti-replay protection
- audit commitments
```

## Scope

This spec covers intents such as:

```txt
Send 0.1 SOL privately to this wallet
Create a private transfer approval
Use privacy mode for this transfer
```

MVP behavior:

```txt
- Validate the action off-chain.
- Create an on-chain private approval using commitments.
- Do not require full Umbra execution for hackathon demo.
- Mark as Umbra-ready in architecture.
```

## Out of Scope

- Building a privacy protocol from scratch.
- Implementing zero-knowledge proofs.
- Custodying private keys.
- Guaranteeing complete anonymity.
- Mainnet privacy execution.

## High-Level Flow

```txt
User asks for private transfer
→ intent parser detects private_transfer
→ backend validates privacy is allowed by UserPolicy
→ backend runs normal transfer safety checks
→ backend creates amount commitment and recipient commitment
→ backend generates action_hash
→ frontend displays privacy-aware confirmation
→ user signs on-chain private approval
→ AgentActionGuard stores approval using commitments
→ optional future execution through Umbra or another privacy layer
→ audit log stores private action metadata securely
```

## Privacy Mode

Supported MVP mode:

```txt
PRIVACY_APPROVAL_ONLY
```

Future mode:

```txt
UMBRA_EXECUTION
```

## Backend Components

### Private Intent Parser

Extracts:

```json
{
  "action": "private_transfer",
  "asset": "SOL",
  "amount": "0.1",
  "recipient": "recipient_pubkey",
  "privacy_mode": "privacy_approval_only"
}
```

### Privacy Policy Engine

Validates:

```txt
- UserPolicy.allow_private_actions is true.
- Asset is allowed.
- Amount is under max private transfer amount.
- Recipient passed wallet risk checks.
- Privacy mode is allowed.
- Confirmation is required.
```

Example policy:

```json
{
  "allow_private_actions": true,
  "max_private_transfer_lamports": 500000000,
  "allowed_private_assets": ["SOL"],
  "requires_confirmation": true
}
```

### Normal Risk Checks Still Apply

Private transfers must still run:

```txt
- recipient public key validation
- getAccountInfo
- reject executable accounts
- OFAC check
- GoPlus check
- Chainabuse check
- user blocklist check
- amount and daily limit checks
```

## Commitments

Instead of storing raw amount and recipient in a private approval, the backend computes commitments.

Example:

```txt
amount_commitment = sha256(amount + salt)
recipient_commitment = sha256(recipient_pubkey + salt)
action_hash = sha256(canonical_private_action_params)
```

The salt must be stored off-chain by the backend or generated client-side depending on final design.

For hackathon MVP, backend-generated salt is acceptable if clearly documented.

## On-Chain Account Extension

This feature may use the same `ActionApproval` account with `action_type = PRIVATE_TRANSFER`, or define a dedicated account.

Recommended dedicated structure for clarity:

```rust
pub struct PrivateActionApproval {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub action_hash: [u8; 32],
    pub action_type: u8,
    pub amount_commitment: [u8; 32],
    pub recipient_commitment: [u8; 32],
    pub expires_at: i64,
    pub executed: bool,
    pub revoked: bool,
    pub bump: u8,
}
```

If implementation time is short, reuse `ActionApproval` and place commitments in hash-bound params off-chain.

## Required Instruction

### create_private_action_approval

Creates an approval for a private action.

Inputs:

```txt
action_hash
amount_commitment
recipient_commitment
expires_at
```

Rules:

```txt
- Must be signed by user.
- UserPolicy.allow_private_actions must be true.
- expires_at must be in the future.
- Approval starts executed=false and revoked=false.
```

Optional:

```txt
revoke_private_action_approval
mark_private_executed
```

These can reuse generic revoke/mark instructions if the implementation uses a common approval account.

## SSE Contract

The backend must not expose unnecessary private data in metadata beyond what the user needs to confirm.

For MVP, the UI can show the full details to the user locally, but the on-chain approval stores commitments.

```txt
event: message
data: {
  "type": "assistant_message",
  "content": "I prepared a private transfer approval. The recipient and amount will be represented on-chain as commitments.",
  "metadata": "{\"requires_confirmation\":true,\"confirmation_id\":\"conf_private_123\",\"function_tool\":{\"display_name\":\"Private Transfer Approval\",\"technical_name\":\"private_transfer_approval\",\"params\":{\"asset\":\"SOL\",\"amount\":\"0.1\",\"recipient\":\"recipient_pubkey\",\"privacy_mode\":\"privacy_approval_only\"}},\"risk_level\":\"medium\",\"policy_result\":\"allowed_with_confirmation\"}"
}
```

## Umbra-Ready Architecture

The MVP should document the future integration point:

```txt
After private approval is created and verified, execution can be routed through Umbra Privacy or another privacy layer.
```

Future flow:

```txt
Private approval exists
→ verify action hash and commitments
→ create Umbra-compatible transfer request
→ user signs Umbra transaction
→ mark private approval executed
```

## Security Rules

### Hard Reject

Reject if:

```txt
- User policy does not allow private actions.
- Recipient fails transfer safety checks.
- Recipient is sanctioned or malicious.
- Amount exceeds private transfer limit.
- Commitments do not match pending action.
- Approval is expired, revoked, or already executed.
```

### Warning

Warn if:

```txt
- External risk APIs are partially unavailable.
- Recipient wallet has low history.
- Privacy mode is enabled for a new recipient.
```

## Compliance Narrative

The product must clearly communicate:

```txt
Privacy is not a bypass around risk checks.
Private actions are allowed only after policy validation, sanctions checks, wallet risk checks, user confirmation, and on-chain approval.
```

## Acceptance Criteria

- User can request a private transfer approval.
- Backend validates privacy policy before approval.
- Normal transfer risk checks still run.
- Backend computes amount and recipient commitments.
- User signs private approval on devnet.
- On-chain approval stores commitments or a hash-bound representation.
- Private approval can be revoked or marked executed.
- README explains Umbra-ready future execution.

## Demo Cases

### Case 1: Private Transfer Allowed

```txt
User: Send 0.1 SOL privately to wallet B
Policy: allow_private_actions=true
Risk: clean recipient
Result: ALLOW_WITH_CONFIRMATION
```

### Case 2: Private Actions Disabled

```txt
User: Send 0.1 SOL privately to wallet B
Policy: allow_private_actions=false
Result: REJECT
```

### Case 3: Risky Private Recipient

```txt
Recipient has severe Chainabuse report
Result: REJECT
```

### Case 4: Commitment Approval

```txt
User confirms
Program stores amount_commitment and recipient_commitment on devnet
Result: Private approval created
```
