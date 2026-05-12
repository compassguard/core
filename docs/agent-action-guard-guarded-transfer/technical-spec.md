# Technical Spec - Agent Action Guard Guarded Transfer

Version: 1
Status: Planned
Date: 2026-05-10
Feature: `agent-action-guard-guarded-transfer`

## Architecture

This spec extends the existing Anchor program at `back/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs`.

Primary additions:

- one config PDA for attestor authorization and pause control
- one `WalletSafetyAttestation` PDA
- one `upsert_wallet_safety_attestation` instruction
- one `guarded_transfer` instruction
- Anchor tests under `back/solana/agent-action-guard/tests/`
- regenerated IDL and typed client output needed by tests

This spec is a dependency of `docs/wallet-safety-validation-onchain-enforcement/`, but it does not own the backend or frontend migration to use the new instruction at runtime.

## Proposed Components

### Existing program state reused

- `UserPolicy`
- `ActionApproval`
- `ActionType::TransferSol`

### New state

#### `GuardConfig`

Purpose:

- hold attestor governance for MVP

Fields:

- `admin: Pubkey`
- `paused: bool`
- `authorized_attestors: Vec<Pubkey>`
- `bump: u8`

Notes:

- bound `authorized_attestors` to a small fixed maximum for predictable account sizing
- exact max can be finalized during implementation, but the account must stay comfortably within normal Anchor test usage

Seeds:

- `["guard_config"]`

#### `WalletSafetyAttestation`

Purpose:

- bind a wallet safety decision to one user, one recipient, and one guarded SOL transfer hash

Fields:

- `user: Pubkey`
- `recipient: Pubkey`
- `action_hash: [u8; 32]`
- `policy_decision: u8`
- `issued_at: i64`
- `expires_at: i64`
- `attestor: Pubkey`
- `bump: u8`

Optional extension fields if needed without changing semantics:

- `reason_code: u16`
- `report_hash: [u8; 32]`

Seeds:

- `["wallet_safety_attestation", user, recipient, action_hash]`

## Instruction Contracts

### `initialize_guard_config`

Needed if no config account exists yet.

Accounts:

- `admin: Signer`
- `guard_config: Account<GuardConfig>`
- `system_program`

Behavior:

- creates the config PDA
- sets initial admin
- sets `paused = false`
- seeds authorized attestors with the initial admin or an explicit provided set

### `update_guard_config`

Accounts:

- `admin: Signer`
- `guard_config: Account<GuardConfig>`

Behavior:

- only current admin may mutate
- updates `paused`
- adds or removes authorized attestors

### `upsert_wallet_safety_attestation`

Accounts:

- `attestor: Signer`
- `guard_config: Account<GuardConfig>`
- `wallet_safety_attestation: Account<WalletSafetyAttestation>`
- `system_program`

Inputs:

- `user: Pubkey`
- `recipient: Pubkey`
- `action_hash: [u8; 32]`
- `policy_decision: u8`
- `expires_at: i64`
- optional `reason_code`
- optional `report_hash`

Validation:

- `guard_config.paused == false`
- signer is in `authorized_attestors`
- `expires_at > now`
- PDA matches canonical seeds

Effects:

- initialize if absent
- otherwise overwrite only the current canonical PDA for the same tuple
- set `issued_at = now`
- store signer pubkey as `attestor`

### `guarded_transfer`

Accounts:

- `user: Signer`
- `user_policy: Account<UserPolicy>`
- `action_approval: Account<ActionApproval>`
- `wallet_safety_attestation: Account<WalletSafetyAttestation>`
- `recipient: SystemAccount`
- `system_program: Program<System>`

Inputs:

- `action_hash: [u8; 32]`
- `amount_lamports: u64`

Validation:

- `user_policy` PDA matches `["user_policy", user]`
- `user_policy.user == user`
- `user_policy.enabled == true`
- `action_approval` PDA matches `["action_approval", user, action_hash]`
- `action_approval.user == user`
- `action_approval.action_hash == action_hash`
- `action_approval.action_type == TransferSol`
- `action_approval.recipient == recipient`
- `action_approval.input_amount == amount_lamports`
- `action_approval.expires_at > now`
- `action_approval.revoked == false`
- `action_approval.executed == false`
- `wallet_safety_attestation` PDA matches `["wallet_safety_attestation", user, recipient, action_hash]`
- `wallet_safety_attestation.user == user`
- `wallet_safety_attestation.recipient == recipient`
- `wallet_safety_attestation.action_hash == action_hash`
- `wallet_safety_attestation.expires_at > now`
- `wallet_safety_attestation.policy_decision != reject`

Execution order:

1. validate all PDAs and fields
2. perform CPI `SystemProgram::transfer` from `user` to `recipient`
3. set `action_approval.executed = true`

Invariant:

- there is no successful transfer path through `guarded_transfer` that leaves `executed == false`

## Error Surface

New or clarified program errors should cover:

- guard paused
- unauthorized attestor
- invalid guard config
- invalid attestation PDA
- missing attestation
- attestation expired
- attestation rejected
- approval field mismatch
- approval already executed
- approval revoked
- approval expired

## IDL And Client Typing

Program-only scope still needs generated artifacts when they are required by tests.

Expected outputs:

- regenerated Anchor IDL for `agent_action_guard`
- typed TS client updates if the repo already generates them from the IDL

Constraint:

- do not add runtime integration work outside the minimum needed to compile or execute Anchor tests

## Risks

- `action_hash` mismatch with the current off-chain format can make valid runtime approvals unusable until integration migrates.
- Unbounded attestor storage would create account sizing risk, so the config vector must be explicitly capped.
- If `warn` semantics are ambiguous, tests may diverge from product expectations; this spec treats `warn` as executable and `reject` as non-executable.
- If the integration layer keeps using direct `SystemProgram.transfer`, the new program invariants remain unexercised in production paths until that dependency is implemented elsewhere.

## Verification

Anchor tests must cover:

- happy path guarded SOL transfer
- wrong `ActionApproval` PDA seeds
- wrong `WalletSafetyAttestation` PDA seeds
- mismatched recipient
- mismatched amount
- mismatched `action_hash`
- expired approval
- revoked approval
- already executed approval
- missing attestation
- expired attestation
- unauthorized attestor on upsert
- replay after one successful execution

Verification should also confirm:

- generated IDL includes `guarded_transfer`
- generated IDL includes `upsert_wallet_safety_attestation`
- typed client artifacts compile for the program test harness if such artifacts are part of the repo workflow
