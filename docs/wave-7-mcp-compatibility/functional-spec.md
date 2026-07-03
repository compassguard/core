# Wave 7 — MCP compatibility and approved execution hardening functional spec

Wave 7 is split into two reviewable slices. Wave 7a closes the safety-critical gaps deferred by Wave 6 in `execute_approved_action`. Wave 7b can then add upstream or mirrored MCP compatibility without mixing external-tool surface area with signer-path hardening.

## Scope Decision

Wave 7a comes first.

The migration plan names Wave 7 as MCP compatibility and upstream hardening, but Wave 6 explicitly deferred approval-proof validation, unsigned transaction payloads, and real devnet transaction submission to Wave 7. Those are execution-safety requirements, so they must be completed before Compass expands its MCP compatibility surface.

## Goals

- Require structured approval proof input for `execute_approved_action`.
- Validate `OnchainActionApprovalProof` with `verifyActionApproval` before execution.
- Reject missing or invalid unsigned transaction payloads before signer lookup.
- Bind the approval proof to the transaction payload by matching the approved `action_hash` before signer lookup.
- Avoid consuming idempotency when proof validation or signer availability fails.
- Replace mock devnet `signAndSendTransaction` behavior with real devnet signing/submission.
- Keep unsafe upstream signer tools blocked unless Compass built and approved the action.
- Keep contracts/types separate from behavior files.
- Keep active code isolated from `legacy/`.

## Non-Goals

- No production private-key custody.
- No mainnet execution readiness claim.
- No durable idempotency persistence.
- No Dynamic wallet backend integration.
- No broad upstream MCP passthrough in Wave 7a.
- No allowlisting of external mutating tools before the approved execution path is hardened.

## Requirements

### Requirement: Approved Action Proof Input

`execute_approved_action` MUST require an approval proof contract in addition to `candidateId`.

#### Scenario: Valid proof is provided

- GIVEN an MCP client calls `execute_approved_action`
- WHEN the request includes `candidateId` and a valid approval proof shape
- THEN Compass MUST continue to proof verification
- AND it MUST NOT reach signer execution before verification succeeds

#### Scenario: Missing proof is provided

- GIVEN an MCP client calls `execute_approved_action`
- WHEN the request omits approval proof data
- THEN Compass MUST return `REQUIRE_ADDITIONAL_CONTEXT`
- AND it MUST NOT consume idempotency or call the signer factory

### Requirement: On-chain Approval Verification

Compass MUST call `verifyActionApproval(proof)` before executing an approved action.

#### Scenario: Proof verification succeeds

- GIVEN the proof matches an unexpired, unrevoked, unexecuted on-chain approval
- AND the transaction payload declares the same approved action hash
- WHEN `execute_approved_action` validates the proof
- THEN Compass MAY continue to signer resolution
- AND audit metadata SHOULD record `approvalVerified: true`

#### Scenario: Proof verification fails

- GIVEN the proof is invalid, expired, revoked, already executed, mismatched, or unverifiable
- WHEN `verifyActionApproval(proof)` returns a failure reason
- THEN Compass MUST return `DENY`
- AND it MUST NOT call any signer method

#### Scenario: Proof does not bind to the transaction payload

- GIVEN an MCP client calls `execute_approved_action`
- WHEN the approval proof omits the approved `action_hash` or `user`
- THEN Compass MUST return `REQUIRE_ADDITIONAL_CONTEXT`
- AND it MUST NOT verify the proof, consume idempotency, or call the signer factory

#### Scenario: Proof action hash differs from payload action hash

- GIVEN an MCP client calls `execute_approved_action`
- WHEN the approval proof `action_hash` differs from `transactionPayload.actionHash`
- THEN Compass MUST return `DENY`
- AND it MUST NOT verify the proof, consume idempotency, or call the signer factory

### Requirement: Transaction Payload Validation

Approved execution MUST include an unsigned `VersionedTransaction` payload and the approved action hash that payload executes, or an equivalent explicit unsigned transaction contract.

#### Scenario: Transaction payload is missing

- GIVEN proof verification succeeds
- WHEN no transaction payload is present
- THEN Compass MUST return a missing-payload failure
- AND it MUST NOT call signer methods

#### Scenario: Transaction payload is valid

- GIVEN proof verification succeeds and unsigned transaction bytes are present
- WHEN local devnet signer configuration is available
- THEN Compass MUST deserialize, sign, and submit the transaction through the signer adapter
- AND return the real network signature

### Requirement: Idempotency Ordering

Compass MUST NOT consume a candidate ID before proof validation and signer availability checks succeed.

#### Scenario: Retryable setup failure

- GIVEN a valid request but no configured local devnet signer
- WHEN execution is attempted
- THEN Compass MUST fail closed without consuming the candidate ID
- AND the caller MAY retry after configuration is fixed

#### Scenario: Execution attempt reaches signer boundary

- GIVEN proof validation, payload validation, and signer availability succeed
- WHEN Compass is about to submit the transaction
- THEN Compass MUST consume the candidate ID before submission
- AND duplicate calls MUST return `DUPLICATE_APPROVAL_EXECUTION`

### Requirement: Wave 7b Compatibility Boundary

Upstream or mirrored MCP compatibility MUST be separate from Wave 7a.

#### Scenario: Unknown upstream tool is called

- GIVEN an upstream or mirrored tool is not explicitly allowlisted
- WHEN an MCP client calls it through Compass
- THEN Compass MUST fail closed
- AND unsafe signing tools MUST remain blocked unless routed through approved execution
