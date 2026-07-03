# Technical Spec: Wave 3 — Transfer behind gateway

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-06-06
- **Estado:** Draft para implementación TDD
- **Feature:** `wave-3-transfer-behind-gateway`

## Arquitectura de integración

Wave 3 cablea el flujo transfer existente a Gateway + Policy sin cambiar el signer model.

```txt
user_message / tool_call transfer
  ↓
chat.ts parse + existing prepareTransferResult()
  ↓
existing wallet safety + on-chain guard metadata evidence
  ↓
Wave 3 transfer gateway adapter
  - classifyToolCall({ toolName: "transfer", mutates: true })
  - createActionCandidate({ chain: "solana", actionKind: "transfer", ... })
  - derive PolicyEvaluationContext
  - loadDefaultPolicy()
  - evaluateAction()
  - build redacted audit event(s)
  ↓
policy decision gate
  - DENY / REQUIRE_ADDITIONAL_CONTEXT → reject before proposal / unsigned tx
  - ALLOW / REQUIRE_HUMAN_APPROVAL → create current approval card
  ↓
PendingProposal stores existing guard metadata + gateway/policy metadata
  ↓
function_approve
  - existing expiry/state/wallet/actionHash checks
  - verify stored gateway/policy fingerprint still matches proposal
  - existing on-chain readiness check
  - buildUnsignedSolTransferTx()
  ↓
frontend wallet signs/sends
  ↓
function_result / function_reject emits audit lifecycle events
```

## Existing modules to reuse

| Module                                       | Current role                                                            | Wave 3 use                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `back/services/executionGatewayContracts.ts` | Gateway decisions, risk classes, action/audit types.                    | Import contracts only; do not mix new behavior here unless contract extension is unavoidable. |
| `back/services/executionGateway.ts`          | Tool classification, candidate creation, audit event builder/redaction. | Reuse `classifyToolCall`, `createActionCandidate`, `buildAuditEvent`.                         |
| `back/services/policy/loadPolicy.ts`         | YAML parser/cache.                                                      | Load `defaultPolicy.yaml`.                                                                    |
| `back/services/policy/policyEngine.ts`       | Pure policy evaluator.                                                  | Evaluate transfer action candidate/context.                                                   |
| `back/services/tools/transfer.ts`            | Transfer validation/display/risk.                                       | Preserve existing validation and display.                                                     |
| `back/services/walletSafetyValidation.ts`    | Wallet safety facts, canonical transfer, action hash metadata.          | Source of recipient/canonical evidence and existing reject semantics.                         |
| `back/services/onchainApproval.ts`           | PDA/readiness checks.                                                   | Preserve before unsigned tx creation.                                                         |
| `back/services/chatSessionStore.ts`          | Pending proposal/session contracts.                                     | Extend with gateway/policy metadata in a separate contract type or imported type.             |
| `back/services/chat.ts`                      | Orchestration entrypoint.                                               | Wire transfer only. Keep heavy helper logic outside if possible.                              |

## Likely files/modules to change

Implementation should keep `chat.ts` as orchestration and extract policy/gateway transfer behavior into dedicated backend services.

| Path                                                                                             | Change                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `back/services/transferGatewayContracts.ts` (new)                                                | Canonical transfer gateway metadata/fingerprint types, audit lifecycle labels, result DTOs. Types/constants only.            |
| `back/services/transferGateway.ts` (new)                                                         | Pure/mostly-pure helpers to build transfer candidate, derive policy context, evaluate policy and verify metadata. No UI/SSE. |
| `back/services/transferAuditLog.ts` or `back/services/audit/transferAuditLog.ts` (new if needed) | Minimal structured in-memory/log sink wrapping `buildAuditEvent`; no durable DB in Wave 3.                                   |
| `back/services/chatSessionStore.ts`                                                              | Add optional `gatewayDecision`/`gatewayAudit` metadata fields to `PendingProposal` using imported contract types.            |
| `back/services/chat.ts`                                                                          | Invoke transfer gateway adapter before proposal; verify metadata in approval; emit audit events for lifecycle.               |
| `back/services/__tests__/transferGateway.test.ts` (new)                                          | Unit tests for context derivation, policy decisions and metadata verification.                                               |
| `back/services/__tests__/chat.test.ts`                                                           | Integration-ish backend tests for proposal denial/fail-closed and approval mismatch path.                                    |
| `docs/api-reference.md`                                                                          | Update only if public `/api/chat` response/request contract changes. No update needed if metadata remains backend-only.      |

## Contracts and type separation plan

Project convention requires canonical types/interfaces/constants in files separate from behavior.

- New transfer-specific contracts MUST live in `back/services/transferGatewayContracts.ts` or another `*Contracts.ts` file.
- `transferGateway.ts` MUST import those contracts and contain behavior only.
- If `PendingProposal` needs new fields, the field type SHOULD be imported from the contracts file rather than declared inline in `chatSessionStore.ts`.
- Audit lifecycle names/reason constants SHOULD be constants in a contracts file, not string literals spread through `chat.ts`.
- Tests may define local fixture builders, but production contracts must stay canonical.

Suggested contract shapes:

```ts
export type TransferGatewayDecisionMetadata = {
  candidateId: string;
  candidateFingerprint: string;
  policyId: string;
  decision: CompassDecision;
  reasonCodes: string[];
  evaluatedRules: string[];
  classificationReasonCodes: string[];
  contextFingerprint: string;
  evaluatedAt: string;
};

export type TransferGatewayEvaluation = {
  candidate: ActionCandidate;
  classification: ToolClassification;
  policyEvaluation: PolicyEvaluation;
  metadata: TransferGatewayDecisionMetadata;
};

export type TransferAuditLifecycle =
  | "proposal_created"
  | "proposal_rejected"
  | "approval_received"
  | "unsigned_tx_prepared"
  | "user_rejected"
  | "result_submitted"
  | "result_confirmed"
  | "result_failed";
```

The exact names can change in implementation, but the separation and data guarantees should not.

## Policy context derivation

`PolicyEvaluationContext` for transfer is the highest-risk part of this wave because policy thresholds are USD-based while current transfer input is SOL.

### amount_usd

Preferred derivation order:

1. If an existing trusted SOL→USDC quote path is available (`getUsdcSolQuote({ input_token: "SOL", output_token: "USDC", input_amount })`), use its output amount as `amount_usd` and record quote source/time in candidate evidence.
2. If a pre-existing, tested SOL/USD fallback exists in the quote service, use it only when the service marks the source clearly (for example `fallback_sol_usd`).
3. If quote/price lookup fails, omit `amount_usd` and allow `evaluateAction()` to return `REQUIRE_ADDITIONAL_CONTEXT` for transfer. Do not invent a price.

Implementation note: if adding price lookup into the proposal path creates flaky tests or provider dependency, wrap it behind an injectable helper and test provider-failure as fail-closed.

### recipient evidence

Use existing wallet safety output before policy evaluation:

- `recipient_address`: `safety.canonical.recipient`.
- `recipient_known`: conservative boolean derived from positive evidence only:
  - `true` if internal/user allowlist or established provider evidence is available;
  - `false` if recipient is valid but unknown/new/no history;
  - `undefined` only when evidence cannot be established, causing `REQUIRE_ADDITIONAL_CONTEXT`.
- `flags.suspicious_recipient`: true if wallet safety returns critical suspicious/abuse/sanctions/provider reasons.
- `blocked_recipients`: remains policy YAML-driven; if wallet safety already `REJECT`s, existing wallet safety block still wins.

If current `WalletSafetyEvaluation` does not expose enough positive evidence to safely mark known recipients, default to `recipient_known: false` rather than guessing true.

### token/action identifiers

- `candidate.toolName`: current tool call name (`transfer`) unless implementation intentionally maps to `transfer_sol` for policy consistency.
- `candidate.actionKind`: `transfer`.
- `context.token_mint`: native SOL identifier or configured devnet SOL mint when available; otherwise omit and include `token: SOL` in candidate params/evidence.
- `context.protocol`: not required for transfer.
- `context.compass_built`: not required for transfer proposal; remains relevant for signing tools only.

## Decision handling

| `PolicyEvaluation.decision`  | Transfer behavior in Wave 3                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ALLOW`                      | Create current approval proposal. Store metadata. Emit proposal audit. No auto-signing.                  |
| `REQUIRE_HUMAN_APPROVAL`     | Create current approval proposal. Store metadata/reasons for approval-time verification and explanation. |
| `REQUIRE_ADDITIONAL_CONTEXT` | Fail closed before proposal with clear missing-context reason. Emit reject audit.                        |
| `DENY`                       | Block before proposal with clear policy reason. Emit reject audit.                                       |
| `REQUIRE_SIMULATION`         | Fail closed unless explicit transfer handling is added and tested.                                       |
| `REQUIRE_POLICY_UPDATE`      | Fail closed; do not create proposal.                                                                     |

## Approval-time verification

Before `buildUnsignedSolTransferTx()`:

1. Rebuild canonical transfer params from `session.userAddress` + `proposal.toolArgs`.
2. Preserve existing `actionHash` check (`buildTransferActionHash` + `hasActionHashMismatch`).
3. Rebuild or verify transfer gateway metadata:
   - candidate params/evidence fingerprint;
   - `policyId`;
   - `decision`;
   - relevant `reasonCodes`/`evaluatedRules`;
   - actor wallet and network.
4. If stored metadata is missing for transfer proposals created after Wave 3, return a fail-closed error (`gateway_context_missing` or equivalent). For old sessions during local dev, it is acceptable to fail closed.
5. If mismatch, do not build tx. Clear or mark proposal failed following current conflict pattern.

The verification must be deterministic and testable without live RPC. Price/evidence lookups should not introduce nondeterminism at approval time. Prefer storing the policy context/fingerprint from proposal time and verifying it against current proposal args + stored evidence rather than fetching fresh market data for approval.

## Audit event strategy

Use Wave 1 `buildAuditEvent()` as the redaction boundary. A minimal Wave 3 audit sink can be:

- an in-memory array in a backend service for tests/local introspection;
- structured `console.info` logs with event kind and redacted metadata;
- or session-attached audit metadata if this already fits existing persistence.

Do not introduce DB/durable audit storage in Wave 3 unless already supported with minimal changes.

Important reason-code boundary: Wave 1 `buildAuditEvent()` top-level `reasonCodes` currently represent gateway/classification reasons. Policy `reasonCodes` and `evaluatedRules` MUST be stored in redacted event metadata unless Wave 3 explicitly extends the audit contract and updates the relevant tests.

Suggested metadata per lifecycle:

| Lifecycle                           | `approvalStatus` | `result`        | Metadata                                                            |
| ----------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------- |
| `proposal_created`                  | `pending`        | `pending`       | `policyDecision`, `policyId`, `reasonCodes`, `candidateFingerprint` |
| `proposal_rejected`                 | `not_required`   | `denied`        | `rejectReason`, `reasonCodes`, `evaluatedRules`                     |
| `approval_received`                 | `approved`       | `pending`       | `approvalSource: user`, `actionHash`                                |
| `unsigned_tx_prepared`              | `approved`       | `pending`       | `recentBlockhash`, `lastValidBlockHeight`, no raw tx                |
| `user_rejected`                     | `rejected`       | `denied`        | user-provided reason if safe/redacted                               |
| `result_submitted/confirmed/failed` | `approved`       | matching status | `transactionSignature` when present, error code/message redacted    |

Redaction rules:

- Never store private keys, auth/session tokens, raw prompts, raw user prompt, raw unsigned tx, signed tx bytes, cookies, headers or provider credentials.
- Wallet addresses, action hashes and transaction signatures may be stored.
- Freeform user rejection/error messages must pass through redaction/sanitization or be omitted.

## Testing and validation plan

Use Vitest backend first. Implementation must follow RED → GREEN per slice.

### Unit tests

`back/services/__tests__/transferGateway.test.ts` should cover:

- builds transfer candidate using Wave 1 contracts;
- derives policy context with `amount_usd` from injected quote helper;
- quote helper failure omits amount and produces `REQUIRE_ADDITIONAL_CONTEXT`;
- unknown recipient maps to `REQUIRE_HUMAN_APPROVAL` under default policy;
- known small recipient can produce `ALLOW` but still marked as `requiresApprovalCard`/proposal-eligible;
- blocked/suspicious recipient produces `DENY`;
- future/unhandled decisions such as `REQUIRE_SIMULATION` and `REQUIRE_POLICY_UPDATE` fail closed;
- metadata fingerprint mismatch is detected;
- audit event builder redacts sensitive metadata and stores policy reasons in metadata rather than confusing them with classification reason codes.

### Chat/session tests

`back/services/__tests__/chat.test.ts` should cover:

- policy `DENY` / `REQUIRE_ADDITIONAL_CONTEXT` does not create pending proposal;
- future/unhandled policy decisions fail closed before proposal creation;
- proposal path stores gateway metadata for transfer;
- approval without gateway metadata fails closed for Wave 3 transfer proposals;
- approval mismatch blocks before unsigned tx build;
- function reject/result emit or store audit lifecycle events.

Where `chat.ts` currently has hard-to-mock internals, prefer extracting helpers into testable services rather than broad rewrites.

### Commands

- `npm run test:back -- back/services/__tests__/transferGateway.test.ts`
- `npm run test:back -- back/services/__tests__/chat.test.ts`
- `npm run test:back`
- `npm test` only if frontend behavior/contracts change
- `npm run lint` for runtime changes

## Pendiente arquitectónico (post Wave 3)

`back/services/chat.ts` sigue siendo el entrypoint de la app anterior (`/api/chat`, SSE, proposals, tool routing). Wave 3 conectó gateway/policy/audit a ese flujo legacy para no romper la UX actual, pero esto no se alinea con `docs/PRODUCT_CONSTITUTION.md`, que define a Compass como MCP Guard / execution firewall y explícitamente dice que el producto no es un chatbot.

Deuda concreta:

- `chat.ts` mezcla orquestación de chat, tool routing, transfer/swap/conditional, approvals, audit y session state. Hay que extraer la lógica de seguridad a un tool boundary independiente (por ejemplo `back/services/guardedTransfer.ts` o `back/services/mcpGuard/*`).
- El frontend del chat no es parte del producto nuevo. Cuando se reescriba el boundary, todo lo que sea “chat hacia el front” debería quedar aislado en `legacy/` o detrás de un adapter explícito.
- El LLM, cuando se use, debe ser parte de la capa de seguridad (intent mismatch, prompt injection, explicación de riesgo), no de un chat de producto.
- Tests primarios de transfer guard deberían vivir contra el servicio del tool boundary, no contra `chat.test.ts`.

Wave 3 se mergea con esta deuda anotada; Wave 4 (MCP server/tool boundary) debe limpiarla antes de seguir agregando swap o conditional detrás del gateway.

## Rollout notes

- Single PR default is acceptable because scope is one mutating flow, but keep slices reviewable and tests-first.
- Preserve current UX and approval semantics to minimize frontend diff.
- If implementation reveals that `amount_usd` cannot be derived reliably without adding a new provider dependency, pause for product/architecture approval rather than silently weakening policy.
- If audit persistence becomes larger than an in-memory/structured sink, defer durable storage to a later wave.
