# COM-86: Audit-Checkpoint Trust Proposal

> Historical proposal, superseded for the current transaction-level devnet
> commitment by `functional-spec.md` and `technical-spec.md`. Statements below
> that exclude Solana submission or say `registration: not_requested` are not
> operative requirements.

## Decision requested

Only the **Board** may select, approve, reject, or activate a strategic baseline: trust-anchor form and initial authority; checkpoint authority, custody boundary, and rotation owner; and registry ownership, revocation resolver, privacy, and permission boundary. The Chief of Staff may approve routine internal planning only and has no strategic-selection, approval, or activation authority. This decision does not govern the already-authorized local evidence-and-audit slice. It authorizes no checkpoint/trust-anchor/registry runtime code, authority material, or external action; those remain subject to a separate security-reviewed proposal.

**Owner:** Board

**Unblock action:** The Board records an explicit approve/reject decision after security review that names each selected baseline control, the next proposal owner, and its required security sign-off. `strategic-baseline-approval.json` is internal proposal metadata only: it is deliberately `pending`, is not Board authorization, and cannot contain approval evidence. The local-slice gate (`npm run preflight:magicblock-devnet`) is runnable and does not imply strategic approval. The separate expected-blocked sentinel (`npm run preflight:magicblock-devnet:strategic-gate`) remains blocked until independently verifiable immutable Board approval evidence is available and a future verifier is designed to validate it. A missing selection is a rejection for strategic implementation purposes.

## Boundary

| Layer | Permitted meaning | Never permitted |
|---|---|---|
| Checkpoint evidence | A signed, redacted Merkle-range claim about immutable audit events | Policy input, approval, capability, or execution input |
| Policy and authorization | Existing Compass controls decide whether an action is permitted | Reliance on checkpoint evidence as a decision |
| Execution | Existing guarded signing/submission path, if separately authorized | Access from this proposal or any future checkpoint verifier |

This proposal is devnet-only, disabled by default, non-custodial, and fail closed. It selects no anchor or authority. A missing, ambiguous, stale, revoked, replayed, or unverifiable checkpoint is `unavailable`; it creates no reviewed digest and cannot influence policy, authorization, signing, submission, delegation, permissions, or execution.

## Canonical references

The canonical requirements are `docs/magicblock-devnet-preflight/functional-spec.md` §§ **Authorization isolation**, **Independently verifiable immutable checkpoints**, and **Review gate and future Solana design**; and `docs/magicblock-devnet-preflight/technical-spec.md` §§ **Controlled producer and execution isolation**, **Threat boundaries**, **Checkpoint provenance contract**, and **Future registration decision gate**. This proposal adds no competing specification.

## Internal publication reference

Paperclip revision `866f912e-3c0a-40a1-a8c9-924195e37724` under key `trust-proposal` is an internal publication reference for this proposal. It is non-authoritative: publication does not prove Board-only authority, Board approval, or immutable approval evidence, and it authorizes no strategic or external action.

## Future acceptance gate

A future implementation proposal is acceptable only when security review verifies all of the following:

| Control | Accept only when | Reject when |
|---|---|---|
| Trust anchor | Exactly one explicitly approved form is pinned: a public verification key **or** immutable registry genesis/authority record; it binds the initial authority and Ed25519 algorithm. | The anchor is absent, self-declared by the checkpoint, mutable, substituted, algorithm-ambiguous, or more than one form is active. |
| Authority rotation | Each closed canonical rotation is verified with the currently trusted predecessor key and names the successor key, `effectiveSequence`, and `effectiveTimestamp`; both thresholds are met. | The predecessor is not trusted, a signature/field/encoding is invalid, either threshold is unmet, or the chain is incomplete. |
| Replay state | An authenticated anchor-bound baseline is created before first use; one durable atomic compare-and-store persists per-authority highest sequence plus seen checkpoint ID and root. | Baseline/state is missing, unreadable, reset, changed, inconsistent, duplicate, or the sequence is not strictly increasing. |
| Staleness | Checkpoint age is at most 24 hours from `createdAt` at verification, unless separately approved policy is stricter. | The clock/format cannot be verified or age exceeds the limit. |
| Revocation | A durable, authenticated revocation record is resolved before accepting or resolving a checkpoint, and disable blocks new writes. | Revocation status is missing, unreadable, stale, forged, or identifies the anchor, authority, key, checkpoint, or digest as revoked. |

The future proposal must also prove the exact `compass.audit-checkpoint/v1` range, JCS signing payload, Ed25519 signature, contiguous Merkle range/count/root, and redacted-event binding described by the canonical specs. It must prove that evidence cannot reach policy or execution paths.

## Explicit non-actions

This proposal performs and authorizes **none** of the following: Solana RPC reads or writes; transaction construction; signing; submission; delegation; custody or private-key generation, access, or storage; registry deployment, registration, or mutation; permission changes; funds; production activation; external publication; service contact; secret access; or any external side effect. Its internal Paperclip publication is non-authoritative proposal metadata and does not evidence or create Board authorization.

## Threat model: six fail-closed scenarios

| Scenario | Fail-closed mitigation | Required evidence | Owner |
|---|---|---|---|
| 1. Substituted candidate or account flags | Resolve only the opaque trusted-plan reference and recompute every candidate/account digest and flag; any mismatch is `unavailable`. | Focused binding test and canonical digest evidence under `functional-spec.md` § **Trusted decoded-plan producer and candidate binding**. | Security reviewer |
| 2. Endpoint, redirect, or RPC escalation | Permit only the literal HTTPS evidence endpoint and method; no Solana RPC client or read/write path exists; malformed or redirected evidence is `unavailable`. | Literal-host rejection test and `technical-spec.md` § **Evidence contract** review. | Security reviewer |
| 3. Forged, stale, replayed, or substituted checkpoint | Verify the Board-approved anchor, predecessor rotation, signature, 24-hour age, and atomic sequence/ID/root state; any missing state is `unavailable`. | Checkpoint/rotation/replay test evidence required by `technical-spec.md` § **Checkpoint provenance contract**. | Security reviewer |
| 4. Evidence-to-execution reachability | Dependency closure rejects bidirectional reachability to dispatcher, policy output, confirmation, simulator, executor, and all handlers. | `pnpm exec vitest --config vitest.back.config.ts --run back/services/__tests__/magicBlockDevnetPreflight.test.ts`. | Engineering owner |
| 5. Unauthorized strategic selection or registry activation | Only the Board can select/approve strategic controls; Chief of Staff is limited to routine internal planning; unapproved options cannot activate anything. | Independently verifiable immutable Board decision and separate security-review evidence; `strategic-baseline-approval.json` and Paperclip publication are non-authoritative metadata. | Board |
| 6. Review overload or ambiguous evidence | A fixed review budget and named evidence package prevent approval by summary or inference; missing evidence is a rejection. | Review checklist below and exact canonical-path citations above. | Chief of Staff (routine planning only) |

## Review budget and workload

- **Board:** one 45-minute strategic decision, limited to the explicit selection record; no technical evidence may be inferred.
- **Security reviewer:** 60 minutes to inspect the six scenarios, canonical sections, and focused-test output.
- **Chief of Staff:** 20 minutes for routine internal planning, evidence completeness, and scheduling only; no strategic approval, selection, or activation.

## Approval checklist

- [ ] Board records approve or reject after security review.
- [ ] Approval keeps the scope devnet-only, disabled by default, non-custodial, and fail closed.
- [ ] Approval explicitly selects exactly one permitted trust-anchor form and names the initial authority, checkpoint authority/custody/rotation owner, and registry ownership/revocation/privacy/permission boundaries.
- [ ] A future implementation proposal is separately security-reviewed before any code or external action.
- [ ] Recommended options remain unselected, unapproved, and inactive until the Board records an explicit decision.

## Status

Strategic checkpoint/registry work is blocked pending the named decision. The local evidence-and-audit slice is implemented separately; `registration` remains `not_requested`.
