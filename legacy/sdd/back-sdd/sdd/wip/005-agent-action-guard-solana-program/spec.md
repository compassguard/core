# 005 - AgentActionGuard Solana Program

## Status
WIP

## Goal

Implement a unique Solana program written in Rust and deployed to devnet to satisfy the hackathon requirement and provide an on-chain approval layer for AI-agent actions.

The program does not custody user funds and does not execute swaps. It stores user-signed approvals and policies that bind sensitive agent actions to exact parameters through an action hash.

## Hackathon Requirement

The project must include:

```txt
A unique Solana program written in Rust using Anchor, Pinocchio, Quasar, or vanilla Rust, deployed at least to devnet.
```

This spec defines that program.

## Program Name

```txt
AgentActionGuard
```

Alternative names:

```txt
SolanaIntentGuard
ActionApprovalRegistry
AgentPolicyGuard
```

## Core Idea

AI agents can propose actions, but they cannot execute arbitrary on-chain operations directly.

Before a sensitive action is accepted, the user must sign an on-chain approval that records:

```txt
- who approved it
- which agent/app proposed it
- what action type it represents
- a hash of the exact parameters
- amount constraints
- expiration
- execution state
- revocation state
```

The backend/frontend must verify the on-chain approval before preparing or marking an action as executed.

## Accounts

### UserPolicy

Stores user-level safety configuration.

```rust
pub struct UserPolicy {
    pub user: Pubkey,
    pub max_transfer_lamports: u64,
    pub max_swap_usd: u64,
    pub max_slippage_bps: u16,
    pub allow_private_actions: bool,
    pub require_confirmation: bool,
    pub enabled: bool,
    pub bump: u8,
}
```

### ActionApproval

Stores approval for one specific agent action.

```rust
pub struct ActionApproval {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub action_hash: [u8; 32],
    pub action_type: u8,
    pub input_amount: u64,
    pub min_output_amount: u64,
    pub max_slippage_bps: u16,
    pub recipient: Pubkey,
    pub expires_at: i64,
    pub executed: bool,
    pub revoked: bool,
    pub bump: u8,
}
```

## Action Types

Represent action type as `u8` for simplicity.

```txt
0 = TRANSFER_SOL
1 = SIMULATED_SWAP
2 = BUY_SOL
3 = PRIVATE_TRANSFER
```

## Instructions

### initialize_policy

Creates a `UserPolicy` PDA for the user.

Inputs:

```txt
max_transfer_lamports
max_swap_usd
max_slippage_bps
allow_private_actions
require_confirmation
enabled
```

Rules:

```txt
- Must be signed by user.
- One active policy per user.
- User can update policy later.
```

### update_policy

Updates an existing `UserPolicy`.

Rules:

```txt
- Must be signed by policy owner.
- Cannot be updated by agent.
- Can enable/disable action approvals.
```

### create_action_approval

Creates an approval for a specific action.

Inputs:

```txt
action_hash
action_type
input_amount
min_output_amount
max_slippage_bps
recipient
expires_at
```

Rules:

```txt
- Must be signed by user.
- UserPolicy must be enabled.
- If action_type is TRANSFER_SOL, input_amount must be <= max_transfer_lamports.
- If action_type is SIMULATED_SWAP or BUY_SOL, max_slippage_bps must be <= policy.max_slippage_bps.
- If action_type is PRIVATE_TRANSFER, policy.allow_private_actions must be true.
- expires_at must be in the future.
- Approval starts with executed=false and revoked=false.
```

### revoke_action_approval

Revokes a pending approval.

Rules:

```txt
- Must be signed by user.
- Cannot revoke if already executed.
- Sets revoked=true.
```

### mark_executed

Marks an approval as executed.

Rules:

```txt
- Must be authorized according to program design.
- Approval must not be expired.
- Approval must not be revoked.
- Approval must not already be executed.
- Sets executed=true.
```

Recommended MVP authorization:

```txt
- Let the user sign mark_executed for simplicity.
```

Alternative post-MVP authorization:

```txt
- Allow a registered agent authority to mark executed.
- Require transaction signature evidence stored off-chain.
```

## PDA Design

### UserPolicy PDA

Seeds:

```txt
["user_policy", user_pubkey]
```

### ActionApproval PDA

Seeds:

```txt
["action_approval", user_pubkey, action_hash]
```

This ensures one approval per exact action hash.

## Action Hash

The backend must compute `action_hash` using canonical JSON serialization of action parameters.

Example canonical params for transfer:

```json
{
  "action_type": "TRANSFER_SOL",
  "user": "user_pubkey",
  "recipient": "recipient_pubkey",
  "amount_lamports": 100000000,
  "expires_at": 1778359200
}
```

Hash:

```txt
sha256(canonical_json_params)
```

The action hash must be shown to the user in a readable preview indirectly through the full action details.

## Backend Responsibilities

The program does not replace off-chain security checks.

The backend must still run:

```txt
- wallet validation
- OFAC check
- GoPlus check
- Chainabuse check
- user policy checks
- simulated quote validation
- confirmation handling
```

The Solana program provides:

```txt
- user-signed approval
- parameter binding through action_hash
- expiration
- revocation
- anti-replay through executed flag
- auditability on devnet
```

## Security Rules

The app must never execute or simulate final acceptance unless:

```txt
- ActionApproval exists on-chain.
- action_hash matches backend pending action.
- user matches connected wallet.
- action_type matches expected action.
- approval is not expired.
- approval is not revoked.
- approval is not executed.
```

## Acceptance Criteria

- Program is written in Rust.
- Program is deployed to Solana devnet.
- Program ID is documented in README.
- `initialize_policy` works.
- `update_policy` works.
- `create_action_approval` works.
- `revoke_action_approval` works.
- `mark_executed` works.
- Frontend can create an approval using connected wallet.
- Backend can verify approval state.
- Transfer, simulated swap, buy SOL, and private action approvals use the same program.

## Demo Cases

### Case 1: Create Policy

```txt
User creates policy:
max_transfer_lamports = 1 SOL
max_slippage_bps = 100
allow_private_actions = true
```

### Case 2: Approve Transfer

```txt
User approves transfer action hash on devnet.
Backend verifies approval before preparing transfer.
```

### Case 3: Approve Simulated Swap

```txt
User approves simulated swap quote.
Backend marks approval executed after simulated completion.
```

### Case 4: Revoke Approval

```txt
User revokes approval before execution.
Backend refuses to execute.
```

### Case 5: Expired Approval

```txt
Approval expires.
Backend refuses to execute.
```

## README Requirements

The README must include:

```txt
- Program name.
- Program purpose.
- Devnet deployment address.
- Setup instructions.
- How to run tests.
- How to initialize policy.
- How to create approval.
- How frontend/backend use the approval.
```
