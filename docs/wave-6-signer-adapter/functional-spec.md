# Wave 6 — Signer adapter boundary and idempotency functional spec

Wave 6 makes the Compass signing boundary explicit without making the backend a production custodian. It defines the signer adapter contract, adds a devnet-only local signer for isolated demos, introduces in-process approval idempotency, and exposes an `execute_approved_action` MCP tool that cannot bypass the guardrail path.

## Current Decision

Wave 6 is intentionally smaller than the first draft of this spec.

The canonical Wave 6 implementation follows `task.json`:

- `execute_approved_action` requires a `candidateId` only.
- `approvalProof`, `OnchainActionApprovalProof`, and `verifyActionApproval` are deferred to Wave 7.
- Actual `VersionedTransaction` signing/submission from the execute handler is deferred to Wave 7.
- `LOCAL_SIGNER_NOT_CONFIGURED` returns `DENY` in Wave 6 instead of returning frontend-wallet metadata.

## Business Problem

Waves 1-5 evaluate risky actions, but execution still needed an explicit boundary. Without that boundary, future signing code could be wired directly into backend or MCP handlers and bypass Compass policy.

Wave 6 closes that gap by making the signer boundary typed, guarded, and testable before any real transaction execution is added.

## Goals

- Define a `SignerAdapter` interface with `getAddress`, `signTransaction`, and optional `signAndSendTransaction`.
- Keep backend signing disabled by default.
- Add a `LocalKeypairAdapter` only for devnet demo use, behind `COMPASS_LOCAL_SIGNER_ENABLED=true`.
- Add an in-memory `ApprovalIdempotencyStore` that consumes each candidate ID only once per server process.
- Register `execute_approved_action` as a signing-risk MCP tool.
- Deny duplicate execution attempts before reaching the signer boundary.
- Keep direct `sign_and_send_transaction` denied and point callers to the approved execute path.
- Cover the behavior with backend tests.

## Non-Goals

- No production private-key custody.
- No Dynamic SDK integration in backend.
- No keeper or automated execution engine.
- No upstream MCP compatibility.
- No durable idempotency persistence.
- No on-chain approval proof verification in Wave 6.
- No actual transaction signing or submission from `execute_approved_action` in Wave 6.

## User-Visible Scenarios

### Compass-approved candidate reaches the execute boundary

Given an agent has a gateway candidate ID from a Compass-guarded flow, when it calls `execute_approved_action`, then Compass consumes the candidate ID, checks signer configuration, audits the attempt, and returns a structured result.

### Duplicate execution is blocked

Given a candidate ID was already consumed in this server process, when the agent calls `execute_approved_action` again with the same candidate ID, then Compass returns `DENY` with `DUPLICATE_APPROVAL_EXECUTION` and does not call the signer factory.

### Backend signer is fail-closed by default

Given `COMPASS_LOCAL_SIGNER_ENABLED` is not set to `true`, when `execute_approved_action` reaches signer lookup, then Compass returns `DENY` with `LOCAL_SIGNER_NOT_CONFIGURED`.

### Local signer is devnet-only

Given `COMPASS_LOCAL_SIGNER_ENABLED=true` and a mainnet RPC target, when the local signer factory is called, then Compass returns `LOCAL_SIGNER_MAINNET_FORBIDDEN`.

### Direct signing remains blocked

Given an agent calls `sign_and_send_transaction` directly, when Compass handles the MCP call, then Compass returns `DENY` and tells the caller to route through guarded tools plus `execute_approved_action`.

## Acceptance Criteria

- Backend does not hold user private keys in any non-devnet, non-demo path.
- `SignerAdapter` is exported from a contracts file and covers `getAddress`, `signTransaction`, and optional `signAndSendTransaction`.
- `LocalKeypairAdapter` is gated behind `COMPASS_LOCAL_SIGNER_ENABLED=true` and blocks mainnet RPC targets.
- `ApprovalIdempotencyStore.consume(candidateId)` returns `ok: true` once and `DUPLICATE_APPROVAL_EXECUTION` on repeats.
- `execute_approved_action` is listed in MCP tools with `riskClass: SIGNING`.
- `execute_approved_action` validates `candidateId`, consumes idempotency, checks signer configuration, and emits audit events.
- Duplicate `execute_approved_action` calls return `DENY` before signer lookup.
- Missing local signer configuration returns `DENY` with `LOCAL_SIGNER_NOT_CONFIGURED`.
- Direct `sign_and_send_transaction` remains denied.
- No `legacy/` imports are introduced.

## Verification

- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`

Latest Wave 6 verification:

- Focused Wave 6 tests: 41 passed.
- Full backend tests: 141 passed.
- Lint: exit 0 with one existing `app/layout.tsx` Fast Refresh warning.
- Typecheck: exit 0.

## Deferred To Wave 7

- Require and validate full `OnchainActionApprovalProof`.
- Call `verifyActionApproval` from `onchainApproval.ts` in the execute handler.
- Pass unsigned transaction bytes into the execute path.
- Sign and/or submit a real `VersionedTransaction` when the devnet local signer is enabled.
- Add frontend-wallet signer-ready metadata if the Dynamic wallet path needs backend coordination.
