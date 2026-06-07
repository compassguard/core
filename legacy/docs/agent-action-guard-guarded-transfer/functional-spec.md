# Functional Spec - Agent Action Guard Guarded Transfer

Version: 1
Status: Planned
Date: 2026-05-10
Feature: `agent-action-guard-guarded-transfer`

## Scope

This spec defines only the missing on-chain enforcement work inside `AgentActionGuard` for guarded SOL transfers.

Included:

- new `guarded_transfer` instruction behavior
- new `WalletSafetyAttestation` account and attestor write path
- program invariants, PDA constraints, replay prevention
- Anchor tests for success and failure cases
- generated IDL and typed client artifacts required to exercise program tests

Excluded:

- frontend proposal UX
- backend chat flow ownership
- replacement of the current backend integration that still uses `SystemProgram.transfer`
- Solscan or other off-chain scoring implementation details
- end-to-end integration ownership already covered by `docs/wallet-safety-validation-onchain-enforcement/`

## Objective

Provide real program enforcement for guarded SOL transfers so that a transfer can only succeed when the same instruction:

- receives the user signer
- confirms `UserPolicy.enabled == true`
- validates a live `ActionApproval` PDA for the exact transfer
- validates a live `WalletSafetyAttestation` PDA for the same user, recipient, and `action_hash`
- performs the CPI to `SystemProgram::transfer`
- marks `ActionApproval.executed = true`

## Problem

The current program contains `UserPolicy`, `ActionApproval`, and conditional oracle execution, but it does not own the guarded SOL transfer path.

Current gaps:

- no `guarded_transfer` instruction
- no `WalletSafetyAttestation` account
- no authorized attestor model
- no Anchor tests for transfer enforcement
- no generated typed client artifacts for the new instruction/account surface

Because the backend integration still uses `SystemProgram.transfer`, the on-chain program cannot yet enforce recipient, amount, attestation freshness, or same-instruction replay prevention for wallet safety transfers.

## Actors

- User signer: authorizes the guarded transfer.
- `AgentActionGuard` program: enforces transfer invariants.
- Authorized attestor: writes or refreshes wallet safety attestations.
- Integration layer: depends on this spec but is not owned by it.

## Use Cases

### Happy path guarded SOL transfer

1. A valid `UserPolicy` exists for the user and is enabled.
2. A valid `ActionApproval` exists for the exact guarded SOL transfer.
3. An authorized attestor creates or refreshes a `WalletSafetyAttestation` for the same user, recipient, and `action_hash`.
4. The user signs `guarded_transfer`.
5. The program validates all bindings, transfers lamports, and marks the approval executed.

### Attestation refresh

1. A prior attestation exists but is near expiry or stale.
2. An authorized attestor calls `upsert_wallet_safety_attestation`.
3. The same PDA is updated with a new TTL and policy decision.

### Replay rejection

1. A guarded transfer succeeds once.
2. The same `ActionApproval` and `action_hash` are reused.
3. The program rejects because `executed == true`.

## Functional Requirements

### `guarded_transfer`

Must:

- require `user` as signer
- derive and validate the `UserPolicy` PDA with stored bump
- reject when `UserPolicy.enabled` is false
- derive and validate the `ActionApproval` PDA with seeds `["action_approval", user, action_hash]`
- reject when approval fields do not match:
  - `user`
  - `action_hash`
  - `recipient`
  - `input_amount`
  - `action_type == TransferSol`
- reject when approval is expired, revoked, or already executed
- derive and validate the `WalletSafetyAttestation` PDA with seeds `["wallet_safety_attestation", user, recipient, action_hash]`
- reject when attestation is missing, expired, or does not match the same user, recipient, and `action_hash`
- reject when attestation policy is `reject`
- allow execution only for `allow` and explicitly-documented `warn` states
- invoke `SystemProgram::transfer`
- set `ActionApproval.executed = true` in the same instruction after successful CPI

### `upsert_wallet_safety_attestation`

Must:

- require an authorized attestor signer
- create or update the canonical attestation PDA
- bind the attestation to `user`, `recipient`, and `action_hash`
- store an expiry timestamp
- store a policy decision at minimum: `allow`, `warn`, `reject`
- reject writes while the attestor config is paused

### Attestor authority model

MVP decision:

- use one minimal config PDA owned by the program
- store `admin`, `paused`, and a bounded list of authorized attestors

Rationale:

- avoids hardcoding authority into the binary
- permits key rotation without redeploying the program
- is the smallest model that still makes attestation gating testable

## Canonical `action_hash`

This spec defines one canonical format for guarded SOL transfer approvals:

- domain separator: ASCII `agent-action-guard:guarded-sol-transfer:v1`
- concatenated bytes in order:
  - `user` pubkey, 32 bytes
  - `recipient` pubkey, 32 bytes
  - `amount_lamports`, `u64` little-endian
  - `approval_expires_at`, `i64` little-endian
  - `cluster`, lowercase UTF-8 bytes

Hash algorithm:

- `sha256(domain_separator || 0x1f || user || recipient || amount_lamports_le || approval_expires_at_le || 0x1f || cluster_utf8)`

Constraint:

- all program tests, IDL consumers, and integration code that create guarded SOL approvals must use this exact format

Known risk:

- the current off-chain hash format may differ from this canonical layout
- the broader integration spec must normalize to this format before reusing existing approvals

## Acceptance Criteria

- The program exposes `guarded_transfer` and `upsert_wallet_safety_attestation`.
- `guarded_transfer` only succeeds when `UserPolicy`, `ActionApproval`, and `WalletSafetyAttestation` all match the same guarded SOL transfer.
- The transfer CPI and `ActionApproval.executed = true` happen within the same successful instruction.
- Replay with the same approval fails.
- Unauthorized attestors cannot create or modify `WalletSafetyAttestation`.
- Anchor tests cover the defined success path and failure matrix.
- Generated IDL and any required typed client artifacts include the new instruction and account types needed by tests.

## Out of Scope

- migrating backend runtime to call `guarded_transfer`
- changing frontend behavior
- reproducing Solscan validation logic on-chain
- SPL token guarded transfers
