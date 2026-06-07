# Technical Spec - AI SDK Agent Migration

Version: 1
Status: Planned
Date: 2026-06-02
Feature: `ai-sdk-agent-migration`
Source: `docs/ai-sdk-agent-migration/proposal.md`, `docs/ai-sdk-agent-migration/functional-spec.md`, `openspec/config.yaml`, `AGENTS.md`, and inspected Compass chat code

## 1. Design summary

Compass will migrate the chat agent from the custom Azure OpenAI Responses bridge to Vercel AI SDK through a backend adapter seam. The migration is adapter-first: `/api/chat`, custom SSE, session/proposal state, guardrail validation, and frontend wallet signing remain stable while model-provider mechanics move behind provider-neutral runtime interfaces.

Primary decisions:

- Keep `app/api/chat/route.ts` thin and keep `back/services/chat.ts` as the product orchestration owner during the first migration slices.
- Add `back/services/agentRuntime/*` as the provider boundary. `chat.ts` calls this boundary, not AI SDK provider APIs directly.
- Preserve `parseDirectTransferIntent` before any model call.
- Treat transfer, swap, conditional buy, and conditional funding as critical intents only. They must route into deterministic handlers already owned by `chat.ts`/backend services.
- Allow AI SDK executable tools only for read-only holdings and quote flows.
- Keep custom SSE events initially and formalize the existing `alert` event mismatch before declaring the protocol stable.
- Add sandbox services only after a concrete workflow requires file/command execution; sandboxes are isolated workspaces, never custody/signing environments.

## 2. Repository discoveries

- Current chat path is `front/src/hooks/useAgentMessage.ts` -> `front/src/lib/api/client.ts` -> `app/api/chat/route.ts` -> `back/services/chat.ts` -> `back/services/azureResponsesClient.ts`.
- `app/api/chat/route.ts` only parses JSON and delegates to `proxyAgenticChat`; this should stay unchanged except if dependency/runtime config requires a separate route-level change.
- `back/services/chat.ts` currently owns session creation, wallet/session authorization, transcript persistence, deterministic direct-transfer pre-parsing, tool-call routing, proposal creation, approval/reject/result handling, and SSE emission.
- `back/services/chatSessionStore.ts` stores one `pendingProposal` per session with TTL plus optional Redis/Upstash/Vercel KV persistence. It also stores `dynamicUserId`, wallet type/provider, and verification metadata that can support sandbox ownership later.
- Existing critical approval code validates wallet ownership, proposal expiry/state, transfer action hash, guard PDAs/attestation readiness, swap guard bypass state, and conditional funding continuation.
- `front/src/lib/api/client.ts` handles SSE events `session`, `token`, `proposal`, `done`, and `error`; it does not currently dispatch `alert` during streams.
- Frontend schemas/types/history UI already include `alert`, and backend emits `alert` in conditional funding and approval responses. This is a protocol cleanup target, not a model migration blocker if handled in a dedicated slice.
- `back/services/guardrailNarration.ts` also imports `azureResponsesClient`; it must be included in provider migration planning or explicitly left on the legacy adapter until replaced.
- `package.json` currently has no `ai`, AI SDK provider, or `@vercel/sandbox` dependency.

## 3. Target architecture

```txt
app/api/chat/route.ts
  -> back/services/chat.ts                         # Compass lifecycle/orchestration owner
      -> back/services/agentRuntime/index.ts       # provider-neutral runtime factory
          -> azureResponsesRuntime.ts              # legacy adapter during extraction/rollback
          -> aiSdkRuntime.ts                       # Vercel AI SDK implementation
          -> toolDefinitions.ts                    # schemas and tool metadata
          -> readOnlyTools.ts                      # AI SDK executable read-only tools
          -> criticalIntents.ts                    # intent-only schemas and normalization
      -> existing backend tool/guardrail services
```

`chat.ts` remains responsible for translating runtime results into Compass events and deterministic handlers. AI SDK internals must not leak into frontend contracts or proposal state.

## 4. Backend adapter boundary

Create an agent runtime module with provider-neutral types. Exact AI SDK imports and function names must be verified after dependency installation.

Suggested files:

- `back/services/agentRuntime/types.ts`
  - `AgentRuntime`, `AgentRuntimeInput`, `AgentTextDelta`, `AgentTextResult`, `AgentToolIntent`, `AgentReadOnlyToolName`, `AgentCriticalToolName`, `AgentRuntimeError`.
- `back/services/agentRuntime/toolDefinitions.ts`
  - Shared Zod/JSON-schema-compatible schemas for critical intents and read-only tools.
- `back/services/agentRuntime/readOnlyTools.ts`
  - AI SDK executable tools for `get_wallet_holdings` and `get_usdc_sol_quote`.
- `back/services/agentRuntime/criticalIntents.ts`
  - Intent-only definitions for `transfer`, `conditional_buy_sol`, and `swap_orca_usdc_to_sol`; no side-effecting `execute`.
- `back/services/agentRuntime/azureResponsesRuntime.ts`
  - Wrap current `callAzureResponses`, `callAzureResponsesStream`, and `parseResponsesStream` behavior behind the new interface.
- `back/services/agentRuntime/aiSdkRuntime.ts`
  - Vercel AI SDK implementation.
- `back/services/agentRuntime/config.ts`
  - Provider selection/config resolution and fail-closed validation.
- `back/services/agentRuntime/index.ts`
  - Runtime factory used by `chat.ts`.

Minimum runtime contract:

```ts
interface AgentRuntime {
  detectToolIntent(input: AgentRuntimeInput): Promise<AgentToolIntent | null>;
  streamText(input: AgentRuntimeInput): AsyncIterable<AgentTextDelta>;
  runReadOnlyTurn(input: AgentRuntimeInput): Promise<AgentTextResult>;
}
```

Contract rules:

- The runtime returns normalized results; it does not mutate sessions, write SSE, create proposals, build transactions, or persist history.
- The runtime may call executable tools only inside `runReadOnlyTurn`.
- Critical tool results are `AgentToolIntent` records only. Deterministic Compass handlers decide whether they are valid.
- Provider errors are normalized so `chat.ts` can emit existing `error` events and fail closed.

## 5. `/api/chat` lifecycle preservation

Initial target flow for `user_message`:

1. Validate payload and authenticated wallet/session context.
2. Get or create session; reset session on wallet mismatch as current code does.
3. Emit `event: session`.
4. Append user text to session and persist best-effort.
5. Mask Solana addresses for model prompt construction.
6. Run `parseDirectTransferIntent(request.content)` before model runtime.
7. If direct transfer matches:
   - validate recipient format;
   - call existing deterministic transfer handler;
   - emit `proposal` only if guardrail proposal creation succeeds;
   - never ask AI SDK to execute transfer.
8. Otherwise call `agentRuntime.detectToolIntent(...)`.
9. Route result:
   - critical intent -> existing `handleTransferToolCall`, `handleOrcaSwapToolCall`, or `handleConditionalBuyToolCall` after address restoration and validation;
   - read-only intent -> `agentRuntime.runReadOnlyTurn(...)`, then emit synthesized `token` text;
   - no intent -> `agentRuntime.streamText(...)`, mapping deltas to `token`.
10. Emit `done` exactly once for successful turns; emit `error` for terminal failures.

JSON request types stay owned by existing handlers:

- `get_history`
- `function_approve`
- `function_result`
- `function_reject`

No AI SDK runtime call should be required for approval, rejection, transaction preparation, or result recording.

## 6. Direct-transfer pre-parser

`parseDirectTransferIntent` remains the first intent gate for supported direct transfer phrases. It is safer than model intent for the initial migration because it deterministically extracts amount/token/recipient and validates recipient format before proposal handling.

Requirements:

- Do not remove or reorder this parser behind AI SDK in early slices.
- Preserve address masking/restoration tests around model-based fallback intent detection.
- If parser matches but recipient is invalid, emit the existing safe `invalid_recipient` error and stop the turn.
- If parser matches and is valid, use existing `handleTransferToolCall` semantics.

## 7. Critical tool intent vs execution

Critical tools:

- `transfer`
- `conditional_buy_sol`
- `swap_orca_usdc_to_sol`
- conditional funding swap generated by backend for devUSDC prerequisite

AI SDK may detect these as structured intents, but it must not execute them. The adapter returns:

```ts
type AgentToolIntent = {
  name:
    | "transfer"
    | "conditional_buy_sol"
    | "swap_orca_usdc_to_sol"
    | "get_wallet_holdings"
    | "get_usdc_sol_quote";
  argumentsJson: string;
  source:
    | "ai_sdk_tool_call"
    | "ai_sdk_structured_output"
    | "azure_responses_tool_call";
};
```

`chat.ts` then:

- restores masked addresses;
- parses and validates arguments;
- rejects ambiguous/malformed values;
- enforces at most one active blocking proposal;
- calls existing guardrail/preparation handlers;
- emits a `proposal` event only after deterministic backend checks pass.

Critical AI SDK tools must be excluded from any autonomous read-only tool loop. If implemented as AI SDK tool declarations, omit side-effecting `execute` and treat tool calls as intent output only.

## 8. Read-only AI SDK tool loop

Read-only tools allowed for AI SDK execution:

- `get_wallet_holdings`
- `get_usdc_sol_quote`

Tool execution boundaries:

- Execution calls existing backend services (`fetchWalletHoldings`, `getUsdcSolQuote`) from backend runtime only.
- The frontend and prompt text are not sources of truth for wallet balances or quotes.
- Arguments are normalized against the session wallet; model-supplied wallet addresses must not override the authenticated/session wallet for wallet-bound holdings.
- Results sent to the model are minimized and include freshness/source context.
- Tool failures produce grounded text saying fresh data is unavailable; no proposals mutate.

Suggested minimized result shapes:

```ts
type HoldingsToolResult = {
  network: "devnet";
  source: string;
  fetchedAt: string;
  walletVerified: boolean;
  balances: Array<{
    symbol: string;
    mint?: string;
    amount: string;
    uiAmount?: number;
  }>;
};

type QuoteToolResult = {
  network: "devnet";
  source: "orca_whirlpool_quote" | "fallback_sol_usd";
  fetchedAt: string;
  inputToken: "USDC" | "SOL";
  outputToken: "USDC" | "SOL";
  inputAmount: number;
  estimatedOutputAmount?: number;
  slippageBps?: number;
  quoteOnly: true;
};
```

AI SDK loop constraints:

- Cap steps/tool calls to the smallest effective number, e.g. one read-only tool execution plus one synthesis step after verifying exact AI SDK API support.
- Do not include critical tools in the executable `tools` map for this loop.
- Do not emit raw JSON as final assistant text except for safe explicit debug requests.
- Add tests for no-hallucination behavior on provider/tool failure.

## 9. Custom SSE protocol and cleanup

Initial migration keeps the custom SSE contract. AI SDK UI streams and `useChat` are out of scope for early slices.

Supported stream events after cleanup:

| Event      | Purpose                                                      |
| ---------- | ------------------------------------------------------------ |
| `session`  | Announces/continues backend session id.                      |
| `token`    | Assistant text delta or synthesized read-only response text. |
| `proposal` | Only event that creates approvable critical UI state.        |
| `alert`    | Typed non-approvable safety/info notice.                     |
| `done`     | Successful turn completion.                                  |
| `error`    | Terminal turn failure.                                       |

Decision: formalize `alert` instead of silently converting it to generic `token`, because backend/session/frontend message schemas already model alerts and the UI has an `AlertBanner`. Implementation must add SSE client callback/schema handling for `alert`, update tests, and update API docs when this API contract is formalized.

Invariants:

- `token` never implies validation, approval, or execution.
- `proposal` remains the only event that can set an approvable pending proposal in UI state.
- `done(awaiting_approval: true)` is only a hint; backend session `pendingProposal` and a valid parsed `proposal` event remain source of truth.
- `error` followed by `done` may remain compatible with current handling, but implementation should avoid double terminal semantics if tests reveal ambiguity.

## 10. AI SDK dependency and documentation preflight

Because the repository currently has no AI SDK dependency, the first implementation slice must be a compatibility preflight.

Required steps before coding against AI SDK APIs:

1. Add dependencies only in the implementation slice, likely `ai` plus the selected provider package (`@ai-sdk/openai`, Azure/OpenAI-compatible provider, AI Gateway provider, or another provider verified from current docs).
2. Inspect installed docs/source after `npm install`, such as `node_modules/ai/README.md`, provider package docs, and relevant source/types. Do not rely on stale examples.
3. Verify whether AI SDK can safely target the existing Azure Responses endpoint/config (`OPENAI_CHAT_MODEL`, `OPENAI_RESPONSES_ENDPOINT` or `OPENAI_API_URL`) or whether Compass should use Vercel AI Gateway.
4. Record the provider decision in the implementation task output and tests.
5. Keep provider config server-only. No provider secrets in frontend, prompts, logs, or sandbox state.

No-go if provider compatibility requires changing the frontend protocol, exposing secrets, weakening guardrails, or allowing autonomous critical execution.

## 11. Provider configuration

Runtime selection should be feature-flagged until rollout completes.

Suggested server-only envs:

- `AGENT_RUNTIME_PROVIDER=azure_responses|ai_sdk`
- Existing Azure-compatible envs: `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, `OPENAI_RESPONSES_ENDPOINT`, `OPENAI_API_URL`, `AZURE_OPENAI_API_VERSION`
- AI Gateway/provider envs only after compatibility decision, e.g. provider API key/model identifiers as required by verified docs

Rules:

- Default to legacy Azure adapter until AI SDK tests pass.
- Missing provider config fails fast in adapter config tests and fails closed at runtime.
- Do not log API keys, auth tokens, raw provider payloads with secrets, or sensitive wallet data.

## 12. Sandbox service boundaries

Sandbox support is conditional and should not be introduced as part of the model-provider swap unless a product workflow needs filesystem/command execution.

Suggested files when enabled:

```txt
back/services/sandbox/
  userSandbox.ts       # get/create/resume by authenticated owner
  sandboxIdentity.ts   # stable salted/hmac owner -> sandbox name
  sandboxPolicy.ts     # command/file/network/resource policies
  sandboxTools.ts      # explicit allowlisted tools, if needed
  types.ts
```

Ownership:

- Prefer `AuthenticatedWalletIdentity.dynamicUserId` or another internal user id.
- If absent, do not create/resume a persistent sandbox.
- A verified wallet fallback is allowed only with server-side HMAC/salt and documented lower confidence.
- Never use raw wallet addresses, PII, or session ids in sandbox names.

Security policy:

- No private keys, seed phrases, wallet signing, custody, Vercel tokens, GitHub tokens, or provider secrets in sandbox.
- Deny arbitrary shell by default; expose allowlisted command/file tools only.
- Enforce timeouts, output limits, storage limits, snapshot expiration, and user-level quotas.
- Deny network egress by default unless a workflow explicitly allows specific endpoints.
- Sandboxes cannot prepare, sign, or execute Solana transactions directly; critical operations still go through backend guardrails and frontend wallet signing.

## 13. File change map for implementation

Planned product-code changes by slice, not performed in this design phase:

- `back/services/agentRuntime/*`: new adapter/runtime modules.
- `back/services/chat.ts`: replace direct `azureResponsesClient` calls with runtime calls while preserving lifecycle and handlers.
- `back/services/guardrailNarration.ts`: migrate or wrap Azure model call through the runtime/narration adapter.
- `back/services/azureResponsesClient.ts`: keep as legacy implementation until rollback window closes; remove only in a later cleanup slice.
- `front/src/lib/api/client.ts`, `front/src/lib/api/schemas.ts`, `front/src/types/api.ts`, `front/src/stores/chatStore.ts`: only for formalizing streamed `alert` handling if selected.
- `docs/api-reference.md`: update when `/api/chat` SSE contract formally includes `alert` or any API contract changes.
- `package.json`/`package-lock.json`: add `ai`/provider dependencies only after preflight.
- `back/services/sandbox/*`: add only in sandbox slice with concrete workflow.

## 14. Test strategy

Strict TDD applies: add failing tests before implementation changes.

Backend tests:

- `back/services/__tests__/agentRuntime*.test.ts`
  - config resolution and no-go missing config;
  - legacy adapter maps Azure outputs to provider-neutral text/intent;
  - AI SDK adapter is mockable and does not expose provider internals.
- `back/services/__tests__/chat.test.ts`
  - `chat.ts` calls runtime adapter instead of `azureResponsesClient` internals;
  - direct-transfer parser still short-circuits before runtime;
  - critical intents route to deterministic handlers and never execute via read-only loop;
  - multiple/invalid critical intents fail closed;
  - holdings/quote read-only results synthesize text and do not mutate `pendingProposal`;
  - address masking/restoration remains intact;
  - approval/reject/result/history wallet mismatch tests remain passing;
  - swap guard bypass requires explicit `accept_risk`;
  - conditional funding result creates the next conditional proposal only after confirmed result.
- Existing domain tests for transfer, wallet safety, on-chain approval, Orca swap, conditional buy, holdings, and quote providers remain in scope.
- Sandbox tests, if enabled:
  - same authenticated owner resolves same sandbox name;
  - different owners resolve different names;
  - missing stable owner refuses sandbox;
  - raw wallet/PII absent from name;
  - policy denies signing/secrets/arbitrary commands.

Frontend/API tests when `alert` stream support is formalized:

- `front/src/lib/api/__tests__/client.test.ts` verifies `event: alert` parsing/callback.
- `front/src/lib/api/__tests__/schemas.test.ts` verifies alert SSE/history schemas.
- `front/src/hooks/__tests__/useAgentMessage.test.tsx` verifies alert messages are displayed without creating approvable proposals.
- Existing proposal approval/signing/guard-bypass tests remain passing.

Commands by change type:

- Backend/API changes: `npm run test:back`.
- Frontend SSE parser/store changes: `npm test` or `npm run test:front`.
- Runtime/dependency/import changes: `npm run lint`.
- Route config/global dependency changes: `npm run build`.
- Type-risky adapter changes: `npx tsc --noEmit` even though no script exists.

## 15. Rollback and no-go criteria

Rollback design:

- Keep `azureResponsesRuntime` available behind `AGENT_RUNTIME_PROVIDER=azure_responses` until AI SDK behavior is proven.
- Maintain existing `/api/chat` request/response and SSE shape during provider swap.
- Do not delete `azureResponsesClient.ts` in the same slice that introduces AI SDK.
- Isolate dependencies and adapter files so reverting provider selection does not affect guardrail handlers.

No-go criteria:

- AI SDK provider path cannot target the selected model without changing frontend chat semantics.
- Provider integration requires exposing server secrets to frontend, prompts, logs, or sandbox.
- AI SDK tool loop requires executable critical tools or weakens deterministic guardrails.
- Read-only tool synthesis cannot be bounded/tested against hallucinated balances or quotes.
- Approval/result/reject/history wallet ownership or one-active-proposal semantics regress.
- Sandbox workflow lacks stable authenticated owner or requires secrets/signing inside sandbox.
- Any slice becomes too broad to review confidently; surface an advisory split recommendation while preserving the user's single-PR default unless they approve a different delivery strategy.

## 16. Implementation slice boundaries

Single PR is the default delivery strategy for this SDD. Keep work organized by reviewable slice commits and recommend splitting only as an advisory if scope becomes hard to review.

1. **Provider/dependency preflight**
   - Add AI SDK dependencies in implementation branch.
   - Verify installed docs/source and provider route.
   - Add adapter config tests and a tiny mocked generation test.
   - No frontend/proposal behavior changes.

2. **Adapter extraction with legacy Azure runtime**
   - Create `agentRuntime` interface.
   - Move current Azure calls behind `azureResponsesRuntime`.
   - Update `chat.ts` and `guardrailNarration.ts` to use adapter seams.
   - Behavior must remain unchanged.

3. **AI SDK text runtime behind flag**
   - Implement AI SDK plain text streaming/generation behind `AGENT_RUNTIME_PROVIDER=ai_sdk`.
   - Map deltas to existing `token` events.
   - Keep critical/read-only tool behavior on legacy path until tests cover tool migration.

4. **SSE alert cleanup**
   - Formalize streamed `alert` support in frontend/API docs/tests, or explicitly convert backend alerts to supported text.
   - Recommended path: add typed `alert` SSE support.

5. **Read-only AI SDK tool loop**
   - Add executable AI SDK holdings/quote tools only.
   - Synthesize natural-language responses from minimized backend results.
   - Confirm no pending proposal mutation from read-only turns.

6. **Critical intent migration**
   - Add AI SDK-compatible intent schemas for transfer/swap/conditional buy.
   - Route normalized intents into existing deterministic handlers.
   - Preserve direct-transfer pre-parser priority and address masking/restoration.

7. **Optional sandbox service**
   - Implement only after product workflow approval.
   - Add `@vercel/sandbox`, owner identity hashing, policy, mocks/tests, and limited tools.

8. **Optional frontend AI SDK UI evaluation**
   - Separate decision after backend stability.
   - Do not migrate to `useChat` unless approval/signature UX and custom guardrail states remain explicit.

## 17. Acceptance checklist

- `/api/chat` initial migration remains compatible with current frontend behavior.
- `chat.ts` still owns session/proposal lifecycle and critical flow handlers.
- Direct transfers still use deterministic pre-parser before model runtime.
- Critical actions are intent-only from AI SDK and route through guardrails before any proposal/unsigned transaction.
- Read-only tools execute server-side, minimize data sent to model, and produce grounded prose.
- Streamed `alert` mismatch is resolved by formal support or explicit conversion.
- Provider decision is tested and reversible at adapter seam.
- Sandbox, if added, is per authenticated user, non-custodial, secret-free, and policy-limited.
