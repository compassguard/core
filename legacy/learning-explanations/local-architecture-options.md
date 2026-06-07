# Contextual explanations architecture options (local-code based)

## 1) What already exists (high-signal patterns)

### Backend already emits structured risk/guardrail facts
- Transfer decisions already carry deterministic wallet-safety reasons/codes/sources via `risk.walletSafety` and are attached to proposals (`back/services/chat.ts:2023-2148`).
- Transfer proposals also include on-chain guardrail metadata (`onchain_guardrail`) that can be reused for explanations (`back/services/chat.ts:2155-2165`).
- Swap flow already emits machine-readable guard metadata and bypass metadata:
  - `swap_guard`, `swap_guard_warning`, `guard_rejection` (`back/services/chat.ts:2748-2877`, `2682-2722`).
- Conditional orders carry reason-like observability (`observedExecutableReason`) in service types (`back/services/conditionalOrders.ts` grep evidence).

### Frontend already consumes structured explanation-like data
- Zod contracts already support:
  - `risk.walletSafety.reasons[]` + `sources[]` (`front/src/lib/api/schemas.ts:11-40`)
  - swap warning/rejection structures (`front/src/lib/api/schemas.ts:207-260`)
- UI already renders progressive risk messaging from reason codes (`front/src/components/chat/proposals/RiskInlineAlert.tsx:17-177`), plus swap-specific warning/bypass components.

### Session/proposal lifecycle is a good anchor for explanation state
- Single active `pendingProposal` per session, with proposal states (`back/services/chatSessionStore.ts`, `docs/transaction-logic/technical-spec.md`).
- Approve path enforces proposal state + expiry + hash consistency (`back/services/chat.ts:2400-2411`, `2898+`).

---

## 2) Architectural decision: where explanations should be generated

### Recommended split (fits current repo)
1. **Backend rules engine = source of truth explanation facts**
   - Should produce normalized explanation objects tied to each guardrail decision.
   - Why: decision evidence is already computed there; avoids frontend inventing security rationale.
2. **Frontend = presentation + progressive disclosure**
   - Uses explanation payload to render summary/details/technical views.
   - Keeps localized copy and UX control in UI.
3. **Agent text layer = optional narrative wrapper only**
   - Can paraphrase, but must not originate/security-decide; only restate backend facts.

This aligns with project principle “critical ops never bypass guardrails”: explanations must attach to guardrail outcomes, not be post-hoc UI copy.

---

## 3) Candidate API/data model (incremental over existing contracts)

## Option A (minimal-change, fastest): extend `risk` and approve metadata
Add a generic explanation envelope attached to proposals and approve responses.

```ts
type GuardrailExplanation = {
  id: string; // stable per decision snapshot
  action_type: 'transfer' | 'swap' | 'conditional_order' | string;
  decision: 'ALLOW' | 'WARN' | 'REJECT';
  severity: 'info' | 'warning' | 'critical';
  summary: string; // 1-line user-safe
  reason_codes: string[]; // deterministic codes
  reasons: Array<{
    code: string;
    message: string;
    source: 'local' | 'policy' | 'onchain' | 'offchain' | 'onchain_approval';
    severity: 'info' | 'warning' | 'critical';
  }>;
  checks: Array<{
    check: string; // e.g. 'solana_rpc_account_lookup'
    status: 'pass' | 'warn' | 'fail' | 'error' | 'not_run';
    evidence?: Record<string, unknown>; // sanitized, no secrets
  }>;
  sources: Array<{ provider: string; status: 'ok' | 'missing' | 'stale' | 'error' }>;
  suggested_user_action?: 'continue' | 'review_destination' | 'reduce_amount' | 'cancel';
  created_at: string;
};
```

Attach as:
- `risk.explanation?: GuardrailExplanation` in proposal messages.
- `guard_rejection.explanation?: GuardrailExplanation` for swap reject/bypass branch.
- `conditional_orders[].observedExecutableExplanation?` derived from `observedExecutableReason`.

## Option B (more explicit, future-proof): top-level `explanations[]`
Emit event-style explanations on every backend response:
```ts
type AgentMessageResponse = {
  messages: AgentMessage[];
  explanations?: GuardrailExplanation[];
  ...
}
```
Pros: reusable across text/proposals/status events. Cons: broader frontend plumbing.

**Recommendation:** start with Option A (minimal churn), keep schema aligned with existing `risk.walletSafety` structure.

---

## 4) Progressive disclosure model (frontend)

Use 3 levels mapped to current UI patterns:

1. **Level 1: Inline summary (default)**
   - Already analogous to `RiskInlineAlert` top label.
   - Show `summary` + decision badge.

2. **Level 2: “Why?” details**
   - Expand to reason list (already pattern via reason-code mapping in `RiskInlineAlert.tsx:17-46`).
   - Include suggested action CTA.

3. **Level 3: Technical evidence**
   - Show checks/providers/status, and on-chain guard identifiers when relevant (`action_hash`, `policy_pda`, etc., already in proposal data).
   - Useful for advanced users/debug, hidden by default.

---

## 5) How to attach explanations to guardrail decisions in existing flows

### Transfer
- Attach explanation at proposal creation right after `evaluateWalletSafety(...)` and before SSE `proposal` emit (`back/services/chat.ts:2023-2180`).
- Decision source: `safety.decisionResult` + canonical params + onchain guard metadata.

### Swap
- Attach explanation in approve response:
  - success path: include oracle/deviation context from `swap_guard` and warning if present (`2811-2877`).
  - rejection path: include structured explanation alongside `guard_rejection` (`2698-2722`).

### Conditional
- Build explanation from conditional decision + executable reasons:
  - proposal-time reasons from `evaluateConditionalBuy` (`~1680+`).
  - monitoring-time reasons from `observedExecutableReason` in conditional order snapshots.

---

## 6) Files likely touched (if implemented)

Backend:
- `back/services/chat.ts` (compose/attach explanation objects in proposal + approve/reject branches)
- `back/services/walletSafetyValidation.ts` (optional helper for normalized explanation builder)
- `back/services/tools/swapGuard.ts` (optional helper fields for explanation checks)
- `back/services/conditionalOrders.ts` (map executable reason -> richer explanation payload)

Frontend contracts:
- `front/src/lib/api/schemas.ts` (new explanation schema fields)
- `front/src/lib/api/client.ts` and `front/src/types/api.ts` (types)

Frontend UI:
- `front/src/components/chat/proposals/RiskInlineAlert.tsx` (consume backend summary/details instead of hardcoded-only mapping)
- `SwapGuardWarning.tsx` / `SwapGuardBypassWarning.tsx` (consume shared explanation model)
- Proposal cards if adding disclosure toggles.

Tests:
- `front/src/lib/api/__tests__/schemas.test.ts`
- `front/src/lib/api/__tests__/client.test.ts`
- backend chat/validation tests under `back/services/__tests__/...`

---

## 7) Validation/testing strategy

1. **Contract tests first**
   - Validate new explanation schema in proposal SSE + approve JSON responses.
2. **Deterministic backend unit tests**
   - For each decision branch (ALLOW/WARN/REJECT, swap guard reject/bypass), assert explanation payload consistency with reason codes.
3. **UI rendering tests**
   - Summary shown by default, details expandable, technical evidence hidden by default.
4. **Regression checks**
   - Existing flows still produce valid current schemas when explanation optional fields are absent (backward compatibility).

---

## 8) Key risks

- **Dual truth risk**: frontend hardcoded explanations may diverge from backend decision logic (already possible today in `RiskInlineAlert`).
- **Schema drift** between backend responses and Zod contracts.
- **Overcoupling to transient text**: use stable codes, not prose, as core interface.
- **Latency creep** if explanation generation relies on extra external calls; should reuse existing computed facts only.

---

## 9) Open questions to resolve before implementation

1. Should explanation payload be mandatory on guarded actions, or optional best-effort?
2. Do we support i18n for `summary/message` now, or keep `code + frontend mapping` as primary?
3. For swap bypass, should UX require explicit acknowledgment checkbox beyond `accept_risk` boolean?
4. For conditional orders, do we expose explanations in polling endpoints only, or also via chat messages when state changes?
5. Should agent free-text always include an explanation summary, or only when decision is WARN/REJECT?

---

## Recommended implementation strategy (concise)

- **Phase 1 (safe incremental):** Option A, backend-generated explanation object embedded into existing `risk`/guard rejection payloads; frontend renders with current components + disclosure toggle.
- **Phase 2:** unify transfer/swap/conditional into shared explanation builder module and migrate hardcoded frontend reason prose to backend-provided summary/details with code fallback.
- **Phase 3:** optional agent narrative synthesis constrained to backend explanation payload (never a decision source).
