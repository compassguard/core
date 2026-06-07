# Local current state: learning/explanations onboarding map

## Scope inspected
- `app/api/*` entrypoints + tests
- `front/src` chat UI/state/API contract layers
- `back/services` chat orchestration, transfer/swap guardrails, wallet safety engine
- docs/specs under `front/docs` and `docs/*`

---

## 1) Current behavior (evidence-backed)

### A. Single chat gateway with mixed SSE + JSON actions
- API entrypoint is thin: `app/api/chat/route.ts:1-19` forwards to backend service.
- Contract shape is explicit in frontend schemas:
  - agent messages (`text | function_call | alert`) with `risk`, optional `onchain_guardrail`: `front/src/lib/api/schemas.ts:111-147`
  - approve response supports `proposal_state`, `swap_guard_warning`, `guard_rejection`, `guard_bypassed`: `front/src/lib/api/schemas.ts:251-266`
- Front client methods align with that protocol (`postApprove`, `postReject`, `postFunctionResult`): `front/src/lib/api/client.ts:344-380`.

### B. Guardrails are already exposed to users in proposal UI
- Transfer proposal includes explicit on-chain guard explanation + expiry copy: `front/src/components/chat/proposals/SendProposalCard.tsx:52-71`.
- Risk explainer already maps machine reason codes to user-friendly Spanish and lists checks/sources (`Solana RPC`, internal lists, Solscan): `front/src/components/chat/proposals/RiskInlineAlert.tsx:17-88` and UI states `:98-177`.
- Swap guard rejection has a dedicated bypass warning card with deviation details and “Ejecutar sin protección”: `front/src/components/chat/proposals/SwapGuardBypassWarning.tsx:31-73`.

### C. Chat state machine blocks unsafe concurrent actions
- Input is blocked while thinking/executing or when a pending proposal exists: `front/src/stores/chatStore.ts:631-634`.
- Approval is blocked for expired/mismatched/stale conversation contexts: `front/src/stores/chatStore.ts:650-662`.
- UI surfaces those read-only states in-chat (`session_expired`, `wallet_mismatch`, `proposal_stale`): `front/src/components/chat/ChatContainer.tsx:56-64`.

### D. Backend enforces transfer guardrail chain before signing
- Transfer flow validates token support, wallet connected, funding sufficiency, safety evaluation, and creates guarded proposal payload:
  - token/unsupported and wallet checks: `back/services/chat.ts:1930-1951`
  - SOL funding precheck with explicit required-overhead message: `back/services/chat.ts:1990-2016`
  - hard safety reject handling: `back/services/chat.ts:2031-2047`
  - proposal includes risk + onchain guardrail metadata (action hash, PDAs, expiry): `back/services/chat.ts:2132-2167`
- Approve path revalidates guard context + readiness before returning unsigned tx:
  - missing context error: `back/services/chat.ts:2930-2939`
  - `verifyTransferGuardReadiness(...)`: `back/services/chat.ts:2942-2963`
  - success message + tx payload w/ `onchain_guardrail`: `back/services/chat.ts:3003-3060`.

### E. Swap guardrail supports warn/reject + explicit risky bypass
- On approve for Orca swap, backend can build guarded tx and detect on-chain guard rejection:
  - guard config + instruction assembly: `back/services/chat.ts:2571-2649`
  - guard rejection payload for frontend (`guard_rejection`, warning message): `back/services/chat.ts:2675-2722`
  - non-blocking warning path (`swap_guard_warning`): `back/services/chat.ts:2762-2777` and response embed `2872-2877`.

### F. Tests already cover key guardrail semantics
- Wallet safety decision tests cover ALLOW/WARN/REJECT, invalid key, Solscan missing/error/ok cases: `back/services/__tests__/walletSafetyValidation.test.ts:18-210`.
- Front schema tests assert on-chain metadata survives SSE proposals: `front/src/lib/api/__tests__/schemas.test.ts:357-402`.
- API tests validate partial warnings behavior for wallet balances: `app/api/wallet/balances/route.test.ts:221-239`.

---

## 2) Existing explainer/copy inventory

### UI copy currently present
- Strong risk rationale text in `RiskInlineAlert` (code-to-explanation mapping): `front/src/components/chat/proposals/RiskInlineAlert.tsx:17-45`.
- Inline “checks performed” section (good onboarding anchor): `front/src/components/chat/proposals/RiskInlineAlert.tsx:48-88, 125-173`.
- On-chain transfer guard explanation block in proposal card: `front/src/components/chat/proposals/SendProposalCard.tsx:56-68`.
- Swap bypass warning with concrete tradeoff language: `front/src/components/chat/proposals/SwapGuardBypassWarning.tsx:35-56`.

### Backend/system messages users receive
- Unsafe/blocked transfer explanations (insufficient funds with overhead, unsupported token, safety reject): `back/services/chat.ts:1944-1948`, `2010-2016`, `2031-2035`.
- Guard readiness / mismatch errors mapped in frontend to friendly guidance: `front/src/hooks/useAgentMessage.ts:22-39`.

### Docs/specs that describe intended educational behavior
- Front spec says risk explanations should come from backend fields or static copy, not fake client-side checks: `front/docs/functional-spec.md:54-63`.
- Token-risk frontend doc defines richer preview/explainer expectations (sources, hashes, decision, acknowledgement): `front/docs/token-risk-guard-frontend.md:31-45, 76-143`.

---

## 3) Gaps for progressive user learning/onboarding

1. **No dedicated “why this decision” progressive panel across all actions**
   - Current explainers are mostly inside transfer risk card; swap/conditional are less structured.
   - Evidence: rich explanatory mapping is transfer-centric in `RiskInlineAlert`; swap warnings are present but narrower.

2. **Inconsistent language/UX tone across flows**
   - Mixed EN/ES labels in key action surfaces (`Confirm Send`, `Cancel`, `Copilot is thinking…`).
   - Evidence: `SendProposalCard.tsx` + `ChatContainer.tsx`.

3. **Guardrail reason codes are not fully normalized into user-facing taxonomy**
   - Backend emits multiple low-level codes; only a subset has curated copy in UI.
   - Evidence: mapping in `RiskInlineAlert.tsx:17-45` is finite; backend can emit broader readiness/approval errors (`useAgentMessage.ts:24-37`, `chat.ts:2957-2960`).

4. **No explicit onboarding sequence for first-time users**
   - Chat has operational messaging but not a structured learn-as-you-go walkthrough (e.g., “what happens before signing”, “what this guard checks now”).
   - Evidence: current flow focuses on transactional states (`MessageList`, proposal cards), not progressive education artifacts.

5. **Docs describe richer token-risk preview contract than current UI visibly renders end-to-end**
   - `front/docs/token-risk-guard-frontend.md` expects detailed preview fields; current app exposes part of it.

---

## 4) Likely integration surfaces (3–5)

1. **`front/src/components/chat/proposals/RiskInlineAlert.tsx`**
   - Best place to add staged explanations (“basic”, “details”, “technical checks”) and unify rationale rendering across transfer/swap/conditional.

2. **`front/src/components/chat/proposals/SwapProposalCard.tsx` + `SwapGuardBypassWarning.tsx`**
   - Add progressive “what this means” and “safe next action” copy for swap warnings/rejections.

3. **`front/src/hooks/useAgentMessage.ts` + `front/src/stores/chatStore.ts`**
   - Add explanation state progression tied to lifecycle events (proposal received, guard warning, guard rejection, signed/submitted).

4. **`back/services/chat.ts` (message composition points around transfer/swap approve)**
   - Canonical source for machine-readable decision context; safest place to enrich structured explanation payloads so frontend doesn’t infer.

5. **`front/src/lib/api/schemas.ts` (and `types/api.ts`)**
   - Contract expansion point for explicit educational payloads (e.g., `explanation_steps`, `decision_summary`, `recommended_next_actions`) with validation.

---

## 5) Constraints/risks to preserve

- Critical operation path already guarded by pending-proposal + approval flow; avoid bypassing this model: `chatStore.ts:631-634`, `useAgentMessage.ts:215-373`.
- Guardrails are partly on-chain and partly off-chain; explanations must differentiate these to avoid misleading users.
- Existing specs indicate feature docs should remain under `docs/<feature>/...` when adding formal SDD artifacts later.

---

## Quick “start here” for next agent
1. `front/src/components/chat/proposals/RiskInlineAlert.tsx` (strongest existing educational copy and reason mapping).
2. `back/services/chat.ts` around transfer + swap approve paths (`1929-2180`, `2561-2877`, `2930-3060`) to identify which structured explanations can be emitted reliably.
3. `front/src/lib/api/schemas.ts` to define any new explanation payload without breaking current clients.
