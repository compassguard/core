# Wave 9 - LLM decision, MCP setup, and devnet hardening functional spec

Wave 9 adds planning specs for optional LLM-assisted guardrail decisions, quick OpenCode MCP setup, and devnet-focused hardening: signer env alias, public-key validation, approvalProof bypass, default actorWallet, recipientKnown default, and transfer payload builder. The implementation MUST preserve deterministic guardrails as the source of truth and MUST NOT loosen security for mainnet.

## Goals

- Add an optional LLM judge path for automatic decision support.
- Keep deterministic policy, risk, simulation, and approval rules authoritative.
- Prepare a fast, secret-safe OpenCode MCP setup flow.
- Keep the feature default-off unless explicitly configured.
- Harden devnet demo flows: signer env alias, public-key validation, approvalProof bypass, default actorWallet, recipientKnown default, and transfer payload builder.
- Ensure mainnet/testnet security guarantees are unchanged.

## Non-Goals

- No production custody.
- No mainnet execution readiness claim.
- No direct model-driven transaction execution.
- No raw prompt, private key, secret, or raw transaction payload sent to an LLM.
- No global OpenCode config mutation without explicit user choice.

## Requirements

### Requirement: Deterministic Guardrails Remain Authoritative

Compass MUST run deterministic classification and policy evaluation before any LLM judge.

#### Scenario: Policy denies an action

- GIVEN deterministic policy returns `DENY`
- WHEN LLM decision support is enabled
- THEN Compass MUST keep `DENY`
- AND the LLM MUST NOT upgrade the decision to `ALLOW`.

#### Scenario: Policy requires approval

- GIVEN deterministic policy returns `REQUIRE_HUMAN_APPROVAL`
- WHEN the LLM judge returns a valid high-confidence recommendation
- THEN Compass MAY attach LLM rationale or risk tags
- AND the final decision MUST remain `REQUIRE_HUMAN_APPROVAL` unless a stricter `DENY` is required.

### Requirement: LLM Judge Is Optional And Fail-Safe

The LLM judge MUST be disabled by default and MUST fail safely.

#### Scenario: LLM config is missing

- GIVEN no LLM provider config is present
- WHEN Compass evaluates a tool call
- THEN Compass MUST use deterministic behavior only
- AND no provider call is attempted.

#### Scenario: LLM output is invalid

- GIVEN the LLM returns invalid JSON, times out, or fails schema validation
- WHEN Compass evaluates the response
- THEN Compass MUST ignore the LLM response
- AND preserve the deterministic decision.

### Requirement: Sanitized LLM Input

Compass MUST send only sanitized decision context to the LLM judge.

#### Scenario: Tool arguments include sensitive material

- GIVEN a tool call includes raw transaction bytes, prompt-like fields, secrets, or keys
- WHEN Compass builds LLM judge input
- THEN those fields MUST be omitted or redacted
- AND audit metadata MUST avoid persisting the sensitive raw fields.

### Requirement: OpenCode MCP Quick Setup

Compass MUST provide a quick setup path for OpenCode MCP usage.

#### Scenario: User runs setup in project mode

- GIVEN a repo with `.opencode/opencode.json`
- WHEN the setup script runs
- THEN it MUST add or update a local MCP server entry for Compass
- AND preserve existing config fields.

#### Scenario: User previews setup

- GIVEN the setup script is run with `--dry-run`
- WHEN config changes are calculated
- THEN it MUST print the planned change
- AND MUST NOT write files.

#### Scenario: Setup handles secrets

- GIVEN environment variables include API keys or signer secrets
- WHEN setup prints output or writes config
- THEN it MUST NOT print or persist those secrets.

### Requirement: Signer Environment Alias and Public-Key Validation

The local signer MUST support a shorter env var alias and an optional public-key mismatch guard.

#### Scenario: Signer accepts COMPASS_LOCAL_SIGNER_SECRET_KEY alias

- GIVEN `COMPASS_LOCAL_SIGNER_SECRET_KEY` is set and `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` is not
- WHEN Compass creates a local signer adapter
- THEN the adapter MUST decode the base58 secret key from the alias and function identically to the original env var.

#### Scenario: Public key mismatch is rejected

- GIVEN `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` is set and does not match the derived signer address
- WHEN Compass creates a local signer adapter
- THEN the adapter MUST return an error with reason `LOCAL_SIGNER_PUBLIC_KEY_MISMATCH`.

#### Scenario: Public key check is skipped when unset

- GIVEN `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` is not set
- WHEN Compass creates a local signer adapter
- THEN the adapter MUST NOT perform the public-key check and MUST succeed as before.

### Requirement: Devnet-Only approvalProof Bypass

On devnet, `execute_approved_action` MUST allow omitting `approvalProof` only when the submitted transaction payload matches a pending payload previously built by Compass. On testnet and mainnet, `approvalProof` MUST remain required.

#### Scenario: Devnet action without approvalProof

- GIVEN network is `devnet`
- WHEN `execute_approved_action` is called without `approvalProof` using a Compass-built pending payload
- THEN Compass MUST skip on-chain approval verification and proceed to payload validation
- AND the audit event MUST include `devnetApprovalBypassed: true`.

#### Scenario: Arbitrary devnet payload without approvalProof

- GIVEN network is `devnet`
- AND no matching pending payload was built by Compass
- WHEN `execute_approved_action` is called without `approvalProof`
- THEN Compass MUST deny before signer lookup
- AND the reason code MUST indicate the payload was not Compass-built.

#### Scenario: Testnet action without approvalProof

- GIVEN network is `testnet` or `mainnet-beta`
- WHEN `execute_approved_action` is called without `approvalProof`
- THEN Compass MUST return `REQUIRE_ADDITIONAL_CONTEXT` with `MISSING_APPROVAL_PROOF`
- AND successful execute-path audit events MUST include `devnetApprovalBypassed: false`.

### Requirement: Default actorWallet from Local Signer

When `actorWallet` is omitted in a tool call, Compass MUST resolve it from the local signer adapter.

#### Scenario: Transfer without actorWallet in local-signer demo mode

- GIVEN the local signer is configured and no `actorWallet` is provided
- WHEN Compass evaluates a `guarded_transfer_sol` call
- THEN the resolved signer address MUST be used as `actorWallet`
- AND gateway evaluation and audit MUST use the resolved wallet.

#### Scenario: Signer unavailable and actorWallet omitted

- GIVEN the local signer is not configured and no `actorWallet` is provided
- WHEN Compass evaluates a transfer
- THEN `actorWallet` MUST remain undefined and the gateway MUST handle it per its own rules.

### Requirement: recipientKnown Defaults to False

When `recipientKnown` is omitted, Compass MUST treat the recipient as unknown (untrusted).

#### Scenario: Transfer without recipientKnown

- GIVEN a transfer call omits `recipientKnown`
- WHEN Compass evaluates the call
- THEN `recipientKnown` MUST default to `false`
- AND the transfer gateway MUST classify the recipient as unknown.

### Requirement: Devnet Transfer Transaction Payload Builder

Compass MUST build unsigned VersionedTransaction payloads for SOL transfers on devnet.

#### Scenario: Devnet transfer produces execution payload

- GIVEN network is `devnet` and the transfer decision is `ALLOW` or `REQUIRE_HUMAN_APPROVAL`
- WHEN Compass evaluates a `guarded_transfer_sol` call
- THEN the result data MUST include `executionPayload` with an unsigned VersionedTransaction
- AND `executionPayloadStatus` MUST be `"ready"`.

#### Scenario: Non-devnet transfer does not produce execution payload

- GIVEN network is `mainnet-beta` or `testnet`
- WHEN the transfer payload builder is called
- THEN it MUST return `TRANSFER_PAYLOAD_UNSUPPORTED_NETWORK`
- AND `executionPayloadStatus` MUST be `"unavailable"`.
