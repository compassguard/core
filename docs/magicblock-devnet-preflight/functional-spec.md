# MagicBlock Devnet Audit-Attestation Functional Spec

## Decision

The COM-68 direct-devnet evidence and COM-71 fail-closed, non-executing boundary are reconcilable: Compass will design an internal, devnet-only **audit attestation** for MagicBlock evidence. The operator-selected Solana registration is a future, review-required design target; this slice does not sign, submit, or register anything on-chain.

The attestation is audit evidence only. It cannot approve, deny, route, simulate, sign, submit, delegate, change permissions, move funds, enable execution, select a strategic option, approve a strategic option, or activate a checkpoint.

## Scope

| Included | Excluded |
|---|---|
| Disabled-by-default local devnet evidence implementation | Signing, submission, transaction construction, Solana RPC reads/writes, checkpoint/registry implementation, or production activation |
| Exact MagicBlock devnet endpoint allowlist | Keys, custody, signing/submission, fund movement, permission changes, delegation/undelegation, commit, registry mutation, or undelegation |
| Redacted audit-attestation schema and review gate | Production activation, external publication, outreach, on-chain writes, or any external commitment |

## Requirements

### Fail-closed evidence boundary

The adapter request URL is the compile-time literal `https://devnet-router.magicblock.app/`: HTTPS only, hostname `devnet-router.magicblock.app`, effective port `443`, pathname `/`, and no username, password, query, fragment, alternate port, IP literal, DNS alias, or redirect. `getDelegationStatus` is the only permitted method. The injected transport receives `maxResponseBytes: 16384` and MUST enforce it while streaming before buffering; the adapter independently rechecks UTF-8 bytes. A delegated response may contain only the literal evidence string `devnet-as.magicblock.app`; it is never parsed or followed as a request target. Validation occurs before dispatch and again after size-bounded, depth/token-bounded, duplicate-safe closed response parsing. Any mismatch, redirect, network change, malformed response, missing evidence, or audit-write failure is `unavailable`; it creates no attestation and makes no recommendation.

### Trusted decoded-plan producer and candidate binding

Only the controlled Compass decoded-plan producer may create a `TrustedDecodedActionPlan`. Its public command accepts only a closed opaque internal-candidate reference. An injected internal candidate source resolves that reference to one immutable candidate action; the producer then clones, validates, and atomically records the candidate's canonical digest, decoded-plan digest, cluster, and allowlisted account digests. It returns an opaque plan reference; callers cannot provide, replace, or supplement a candidate, plan, account, flag, or digest.

For every candidate account, the producer uses one canonical immutable account projection: `{ accountIndex, publicKey, isSigner, isWritable, isProgram, isPayer }`. `accountIndex` is the zero-based ASCII decimal index without leading zeroes; `publicKey` is the canonical base58 public-key text; every flag is the ASCII literal `true` or `false`. The projection is UTF-8 RFC 8785 JCS, and `accountDigest = SHA-256(UTF8("compass.magicblock-devnet-preflight/v1/account\\0") || JCS(projection))`, rendered as 64 lowercase hexadecimal characters. `candidateDigest` is SHA-256 over the JCS UTF-8 immutable candidate projection, whose ordered `accounts` member contains those exact projections and whose account order is part of the digest. The immutable candidate also has a producer-assigned opaque `candidateId`; its `candidateId`, `candidateDigest`, every account digest, and every listed security-relevant flag are persisted together. No omitted, synthesized, defaulted, or caller-supplied account/flag is trusted.

```ts
type TrustedDecodedActionPlan = {
  schemaVersion: "compass.trusted-decoded-action-plan/v1";
  planId: string;
  candidateId: string;
  candidateDigest: string;
  decodedPlanDigest: string;
  cluster: "devnet";
  accountDigests: readonly string[];
};
```

The MagicBlock preflight resolves that reference through the controlled producer and, before any provider result can be parsed, recomputes the candidate digest, decoded-plan digest, **every** account digest, and **every** `isSigner`, `isWritable`, `isProgram`, and `isPayer` flag from immutable candidate data. It rejects absence, count/order mismatch, digest mismatch, flag mismatch, missing binding, unknown field, or non-devnet plan as `unavailable`. A raw transaction, caller-provided decoded plan, account list, flag, or precomputed digest is never evidence input.

### Canonical provider delegation record

For each trusted candidate account, the only acceptable provider evidence is this closed `delegationRecord` object; all members are required and no extra or duplicate JSON member is permitted:

```ts
type DelegationRecordV1 = {
  schemaVersion: "magicblock.delegation-record/v1";
  candidateId: string;
  candidateDigest: string;
  accountDigest: string;
  status: "delegated" | "base_layer";
  evaluatedSlot: string;
  commitment: "processed" | "confirmed" | "finalized";
  evidence: { endpointHost: "devnet-as.magicblock.app" };
};
```

`evaluatedSlot` is an ASCII decimal string without leading zeroes. The preflight accepts a record only after its schema, syntax, closed fields, `candidateId`, `candidateDigest`, `accountDigest`, `status`, `evaluatedSlot`, commitment, and literal evidence host bind exactly to the resolved immutable candidate and the account currently evaluated. Each collect creates a unique evaluation ID using `randomUUID` by default; any injected factory is an internal trusted dependency and its output must pass the closed opaque-identifier validation. The JSON-RPC request ID is domain-separated SHA-256 over that ID, `observedAt`, `candidateId`, `candidateDigest`, and the current `accountDigest`; the response must echo it. “Stale for the evaluation” means replayed or substituted from a different evaluation binding, not comparison with a chain tip. No Solana freshness read is performed. An absent, malformed, incomplete, oversized, over-complex, extra, duplicate, untrusted, replayed, or mismatched record is `unavailable`; no provider result is usable until all candidate accounts have a valid bound record.

### Authorization isolation

The existing `simulate_transaction` classification may return `ALLOW`. That result is not an authorization decision for this slice. The MagicBlock adapter is audit-only and MUST be structurally unreachable from every authorization or execution path: tool dispatcher, policy decision output, confirmation gate, signer, sender, submitter, delegation/permission handler, and transaction executor. No adapter output may be mapped to `ALLOW`, a capability, an approval, or an executable input.

The implemented TypeScript-AST dependency-closure guard treats Types, Canonical, Producer, Adapter, AuditWriter, and Integration as feature roots and traverses their complete import closure. It resolves static imports, static re-exports, and literal dynamic imports. Feature use of external packages, non-`node:crypto` builtins, direct network/process capabilities (`fetch`, `globalThis.fetch`, WebSocket-family APIs, or `process`), unresolved/nonliteral imports, or local imports outside `app`, `back`, `hosted`, and `shared` fails closed. From every protected boundary, the guard separately traverses the entire reachable local closure and applies parse, CommonJS, nonliteral dynamic, unresolved, and out-of-source-root checks to every node, preventing a protected helper from hiding a reverse edge. It rejects reachability in either direction with authorization/execution paths and rejects any non-feature source module that bridges a feature node and a protected node. Ordinary bare packages outside the feature closure remain permitted.

### Internal attestation authority and source of truth

The **Compass Audit Attestation Authority** is an internal, non-custodial audit producer, not a wallet, signer, key custodian, or on-chain writer. Its sole output is a write-once event in the Compass append-only audit ledger, the source of truth for this slice. The ledger assigns an opaque immutable `auditEventId`, persists the canonical payload and its digest, and preserves the prior-event digest to make alteration or removal detectable. An attestation exists only after that write succeeds; the `auditEventId` binds every reviewed digest to its immutable audit event. No external system is authoritative for the attestation.

### Future independently verifiable immutable checkpoints (blocked)

Ledger hash links alone do not prove provenance. The implemented local slice deliberately emits no checkpoint. Any future separately approved checkpoint source MUST emit exactly one `compass.audit-checkpoint/v1` form: a write-once Merkle root over one ordered, contiguous, inclusive audit-event range. Chain-tip checkpoints are unsupported and MUST fail closed. Checkpoint and rotation records use RFC 8785 JCS over UTF-8. Their schemas are closed: an unsupported schema version, missing field, extra field, duplicate JSON member, invalid field value, non-JCS encoding, or any serialization other than the exact payload below fails closed as `unavailable`.

The checkpoint record has exactly these fields, in this field set (JCS determines byte order): `schemaVersion`, `checkpointId`, `sequence`, `createdAt`, `firstAuditEventId`, `lastAuditEventId`, `eventCount`, `rootDigest`, `authorityId`, `keyId`, `signatureAlgorithm`, `authorityRotationChain`, and `signature`. `schemaVersion` is exactly `compass.audit-checkpoint/v1`; `checkpointId` is lowercase canonical UUID; `sequence` and `eventCount` are ASCII decimal strings without leading zeroes; `createdAt` and rotation timestamps are RFC 3339 UTC strings with exactly three fractional digits; digests are 64 lowercase hex characters; and identifiers are non-empty ASCII strings. The checkpoint signing payload is the exact checkpoint object with only its top-level `signature` member omitted; it includes the complete rotation chain, including each rotation signature. `signature` is the unpadded base64url encoding of a 64-byte signature.

Each ordered `authorityRotationChain` member has exactly `schemaVersion`, `predecessorAuthorityId`, `predecessorKeyId`, `successorAuthorityId`, `successorKeyId`, `successorPublicKey`, `signatureAlgorithm`, `effectiveSequence`, `effectiveTimestamp`, and `signature`. Its `schemaVersion` is exactly `compass.audit-rotation/v1`; its signing payload is that exact object with only its `signature` member omitted, canonicalized with JCS UTF-8. `successorPublicKey` is unpadded base64url for exactly 32 raw bytes. Only `signatureAlgorithm: "Ed25519"` is accepted. `keyId` and every predecessor/successor key ID are exactly `sha256:` followed by lowercase SHA-256 hex of those 32 raw public-key bytes. The checkpoint signature is verified against the resolved key named by `keyId`; each rotation signature is verified against its resolved predecessor key. No other algorithm, key type, key identifier, padding, text encoding, or signature encoding is accepted.

Future verifier acceptance requires an explicitly security-approved trust anchor before any checkpoint is accepted: either a pre-approved pinned public verification key or an immutable on-chain registry genesis/authority record. The selected anchor must identify the initial authority and verification algorithm; a key rotation is valid only when its canonical rotation record is signed by the currently trusted predecessor key and names the successor key, `effectiveSequence`, and `effectiveTimestamp`. A rotation applies only when both `checkpoint.sequence >= effectiveSequence` and `checkpoint.createdAt >= effectiveTimestamp`; otherwise the predecessor remains required. The authority rotation chain is evidence only until that rule is verified from the anchor; self-asserted identities or chains are not trusted.

The checkpoint MUST state `firstAuditEventId`, `lastAuditEventId`, and `eventCount`; those IDs delimit one contiguous, inclusive ledger sequence in ascending immutable ledger order. Each leaf is `SHA-256(UTF8("compass.audit-checkpoint/v1/leaf\\0") || UTF8(auditEventId) || 0x00 || bytes.fromHex(attestationDigest))`; leaves are ordered by that sequence. Each internal node is `SHA-256(UTF8("compass.audit-checkpoint/v1/node\\0") || left || right)`, and an odd final node is duplicated as its own right sibling. `rootDigest` is the lowercase-hex root. The verifier MUST obtain and verify the full disclosed range from the ledger, including contiguity and `eventCount`, or obtain a valid membership proof for the event being verified plus authenticated range/count metadata that binds the same root; a partial unverified event path is insufficient.

An independent verifier obtains the immutable checkpoint record and the disclosed redacted event path, recomputes each canonical event digest and the Merkle root, verifies the covered range and `rootDigest`, resolves `authorityId` through the complete anchored rotation chain effective under both timestamp and sequence, and verifies the checkpoint signature with that resolved key before accepting it. Before any checkpoint is accepted, authenticated provisioning atomically creates an anchor-bound baseline with the immutable anchor identifier/digest, initial authority, algorithm, an empty replay set, and status `uninitialized`; it is created only after verifying that exact approved anchor and may not be inferred from a checkpoint. First initialization atomically transitions that existing baseline from `uninitialized` to `active` with the first accepted replay state. A missing, unreadable, changed, reset, or already-inconsistent baseline/state is never first initialization and fails closed. The verifier durably persists, per authority, the highest accepted `sequence` and the seen `checkpointId` and `rootDigest`. In one atomic compare-and-store transaction, it rejects a previously seen ID/root or a non-increasing sequence; only a valid strictly increasing checkpoint may update all state. Missing, unreadable, reset, malformed, replayed, stale, conflicting, substituted, or unverifiable checkpoint material fails closed as `unavailable`; it cannot establish provenance or create a reviewed digest. Staleness is at most 24 hours from `createdAt` to verification unless a future separately approved policy makes the limit stricter.

Checkpoint registration on devnet Solana or MagicBlock is a separately gated future implementation. It requires an approved authority and security-reviewed registry design, remains non-executing, and is not requested or implemented by this change.

### Checkpoint revocation lifecycle

Before accepting or resolving a checkpoint, the verifier MUST resolve a durable authenticated revocation record bound to the approved anchor. Missing, unreadable, stale, forged, or revoked anchor, authority, key, checkpoint, or digest state is `unavailable`; disable blocks new checkpoint writes.

### Audit attestation

Every eligible result is represented by this redacted internal record before any future registration review:

```ts
type MagicBlockDevnetAuditAttestationV1 = {
  schemaVersion: "magicblock-devnet-attestation/v1";
  eventType: "magicblock_devnet_audit_attestation";
  auditEventId: string;
  occurredAt: string;
  cluster: "devnet";
  candidateDigest: string;
  decodedPlanDigest: string;
  evidence: {
    endpointHost: "devnet-router.magicblock.app";
    method: "getDelegationStatus";
    observedAt: string;
    accountDigests: readonly string[];
    classifications: readonly ("delegated" | "base_layer")[];
  };
  outcome: "review_required" | "incompatible";
  rationaleCode:
    | "DELEGATION_STATUS_CONFIRMED"
    | "DELEGATION_STATUS_INCOMPATIBLE";
  registration: "not_requested";
};
```

Only allowlisted fields may be recorded. SHA-256 digests replace account identifiers and configuration values. The record excludes raw addresses, transaction bytes, instruction data, signatures, private material, credentials, provider error bodies, approval state, execution state, raw RPC inputs, and raw RPC responses.

### Structured redacted audit writer

The only writer is the Compass Audit Attestation Authority. Its write command accepts exactly the resolved `TrustedDecodedActionPlan` and validated literal-host evidence; callers cannot supply an outcome or rationale. It recomputes the candidate and plan digests, validates every evidence binding, then derives `review_required`/`DELEGATION_STATUS_CONFIRMED` only when every classification is `delegated`, or `incompatible`/`DELEGATION_STATUS_INCOMPATIBLE` when any is `base_layer`. Before awaiting the ledger it clones and deep-freezes its own redacted command snapshot; the ledger callback never rereads caller-owned objects. It writes the complete canonical record atomically, then returns only `{ auditEventId, attestationDigest }`. A failed binding, redaction, canonicalization, or durable write returns `unavailable` from the integration with no audit record or recommendation.

The canonical payload is the attestation object without any derived digest, serialized as RFC 8785 JSON Canonicalization Scheme UTF-8 bytes. `attestationDigest = SHA-256(UTF8("compass.magicblock-devnet-attestation/v1\0") || JCS(canonicalPayload))`. The prefix is required, `auditEventId` is included in `canonicalPayload`, and hashes are lowercase hexadecimal. Different serializations, omitted fields, unrecognized rationale codes, or sensitive/raw inputs are rejected as `unavailable`.

### Review gate and future Solana design

The only proposed on-chain value is the immutable digest of a reviewed attestation. A future change must name a registry/program, signer authority, retention and revocation model, replay protection, privacy review, and independent security approval. It must also prove that the registry has no instruction or account relationship that can authorize, prepare, route, or execute a Compass action. Until then, `registration` is always `not_requested`.

## Acceptance criteria

- [ ] The design is disabled by default and devnet-only.
- [ ] The literal Router endpoint and method are the only evidence origin; the literal AS FQDN is response-only.
- [ ] Invalid or absent evidence, endpoint mismatch, and audit failure fail closed as `unavailable`.
- [ ] Only the controlled producer can create `TrustedDecodedActionPlan`; the preflight resolves its opaque reference and recomputes the immutable candidate and decoded-plan binding.
- [ ] Before a provider response is used, the preflight recomputes every canonical account digest and `isSigner`, `isWritable`, `isProgram`, and `isPayer` flag from immutable candidate data, failing closed for any absence or mismatch.
- [ ] Each provider `delegationRecord` is closed, well formed, and bound to the trusted candidate ID/digest, evaluated account digest, status/evidence, slot, and commitment; absent or mismatched records fail closed.
- [ ] `simulate_transaction` remains classified independently; its current `ALLOW` result cannot reach MagicBlock preflight, authorization, confirmation, signing, submission, or execution.
- [ ] Attestation evidence is redacted and contains no secrets, raw accounts, signatures, transactions, approval state, or execution state.
- [ ] The structured writer accepts only a bound trusted plan and validated evidence, rejects unknown or sensitive fields, and returns an audit event/digest only after an atomic durable ledger write.
- [ ] The internal non-custodial authority writes the immutable, tamper-evident audit event before a reviewed digest exists.
- [ ] The append-only audit source emits only the exact signed Merkle-range checkpoint schema; chain-tip forms are rejected.
- [ ] Before accepting a checkpoint, an independent verifier validates an explicitly approved pinned public key or immutable registry genesis/authority trust anchor, each predecessor-authorized key rotation effective by both timestamp and sequence, the resolved-key checkpoint signature, and the redacted event path and checkpoint Merkle root.
- [ ] Merkle checkpoints specify contiguous inclusive range IDs, count, canonical leaf ordering and encoding, domain-separated leaf/internal hashes, odd-node duplication, and root; verification requires the complete range or a membership proof plus authenticated range/count metadata.
- [ ] Checkpoint and rotation signatures use only JCS UTF-8 serialization of their exact listed field sets with their own signature field excluded; reordered source members canonicalize to the same signed bytes, while omitted or extra fields, duplicate members, and ambiguous key/signature/text encodings fail closed.
- [ ] The verifier permits only an authenticated anchor-bound atomic first bootstrap; it durably and atomically compares per-authority sequence plus seen checkpoint ID/root thereafter, and fails closed for missing, lost, reset, replayed, decreasing, stale, conflicting, substituted, or unverifiable checkpoint material.
- [ ] Rationale is one of the defined codes and the domain-separated canonical digest can be reproduced without sensitive or raw inputs.
- [ ] The attestation cannot be consumed as authorization or an execution input.
- [x] The runnable closure guard covers every feature entrypoint, integration caller, and concrete audit writer; it resolves static imports/re-exports/literal dynamic imports, fails closed for unresolved/nonliteral imports or external feature dependencies, and proves no authorization or execution reachability.
- [ ] Any Solana registration remains `not_requested` until Board review and a separate security-approved implementation change; the Chief of Staff may approve routine internal planning only.
- [ ] A future registry proposal cannot proceed unless it rejects duplicate `(schemaVersion, auditEventId, attestationDigest)` registrations; rejects a digest whose review binding, schema, cluster, or event digest differs; and rejects evidence more than 24 hours old.
- [ ] That proposal includes a tested rollback: disable prevents new writes, a recorded revocation makes the digest unusable on resolution, and replay or stale resolution fails closed. It must prove those controls before devnet rollout.
- [ ] That proposal separately approves the checkpoint trust anchor, rotation authorization rule, verifier durable-state design, checkpoint registration authority, and a non-executing devnet Solana/MagicBlock registry design; no private key or live registry is introduced by this change.

## Rollout and rollback

The local evidence-and-audit slice is implemented and disabled by default. Rollback is disabling or removing its composition; there is no on-chain state to unwind. Checkpoint, trust-anchor, registry, and strategic activation remain future and blocked.

## Traceability

This design traces COM-68's direct-devnet research to COM-71's reviewed fail-closed, non-executing decision. The COM-68 and COM-71 source artifacts are unavailable in this repository; this trace relies on the reviewed decision recorded in these preflight artifacts and does not claim unavailable source text as evidence.
