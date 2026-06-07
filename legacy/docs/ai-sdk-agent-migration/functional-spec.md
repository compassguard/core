# Functional Spec - AI SDK Agent Migration

Version: 1
Status: Planned
Date: 2026-06-02
Feature: `ai-sdk-agent-migration`
Source: `docs/ai-sdk-agent-migration/proposal.md`, `openspec/config.yaml`, `AGENTS.md`, and existing chat/guardrail feature specs

## Overview

Migrate the Compass chat agent from the custom Azure Responses bridge to a Vercel AI SDK-based runtime while preserving the current guardrail-first transaction lifecycle.

The migration MUST be adapter-first: Compass product behavior remains owned by backend chat orchestration, while the model-provider seam changes behind a provider-neutral runtime. The first migration slices MUST keep the current `/api/chat` request/response semantics and custom SSE protocol stable.

## Scope

Included:

- Vercel AI SDK-backed model/runtime behavior behind a backend adapter.
- Preservation of deterministic proposal, approval, rejection, result, and history flows on `/api/chat`.
- Preservation of custom SSE events in the initial migration.
- Read-only tool execution and model synthesis for holdings and USDC/SOL quote answers.
- Structured critical intent detection only when routed into deterministic Compass handlers.
- Guardrail-first treatment for transfer, swap, conditional order, and conditional funding flows.
- Functional boundaries for optional per-user persistent sandbox workspaces.
- Privacy, data-minimization, wallet ownership, and failure-mode requirements.

Excluded:

- Frontend migration to AI SDK `useChat` in the first migration slice.
- Autonomous model execution of critical transactions.
- Any weakening or removal of backend/on-chain guardrails.
- Backend custody, backend signing, private-key handling, or signed transaction execution by the backend.
- Mainnet/product expansion beyond behavior already supported by existing transaction features.
- Adding sandbox command/file tools before a specific product workflow requires them.
- Removing LangGraph or other unused dependencies as the first migration objective unless separately isolated and tested.

## Actors

- User: chats with Compass, connects a wallet, approves/rejects proposals, and signs transactions in the wallet.
- Frontend chat UI: consumes custom SSE events, renders proposal cards, coordinates wallet signing, and reports optional execution results.
- Backend chat service: owns session state, transcript, tool routing, proposals, approvals, guardrails, and SSE emission.
- Agent runtime adapter: hides Vercel AI SDK/provider mechanics from Compass product behavior.
- Model provider/runtime: generates assistant text and may detect structured intents or run approved read-only tools.
- Backend tool services: provide holdings, quotes, wallet safety, swap, transfer, conditional order, and policy checks.
- Sandbox service, if enabled: provides isolated per-user workspace capabilities without custody, signing, or production secrets.

## Functional Requirements

### FR1 - Migration boundary and compatibility

- The system MUST preserve the existing `/api/chat` contract for the initial migration slices.
- `app/api/chat/route.ts` SHOULD remain a thin route handler that delegates product behavior to backend services.
- Backend chat orchestration MUST remain responsible for session ownership, transcript management, proposal lifecycle, approval handling, result handling, and SSE emission.
- The AI SDK integration MUST be hidden behind a provider-neutral backend adapter so that product flows do not depend directly on provider-specific AI SDK APIs.
- The migration MUST be reversible at the adapter seam until equivalent behavior is proven by tests.
- If AI SDK provider compatibility requires changing the frontend protocol, exposing secrets, or weakening guardrails, the migration slice MUST stop or fall back to the existing provider bridge.

### FR2 - Guardrail-first critical transaction lifecycle

- Critical actions MUST NOT execute directly from an autonomous model/tool loop.
- Critical actions include, at minimum, wallet transfers, swaps, conditional buy/order creation, and conditional funding proposals.
- Every critical action MUST pass deterministic Compass backend guardrails before a proposal is created or an unsigned transaction is returned.
- The model MAY propose or detect structured critical intent, but deterministic backend handlers MUST own validation, proposal creation, proposal state, transaction preparation, expiry checks, hash checks, and result recording.
- Direct transfer requests that are safely covered by the current deterministic parser MUST continue to use deterministic handling until a later migration proves AI SDK intent detection is at least as safe.
- A session MUST have at most one active `pendingProposal` unless a later feature explicitly changes the proposal model.
- Approval, rejection, and result requests MUST be bound to the active session and expected wallet identity.
- Frontend signing MUST remain self-custodial: the backend returns unsigned transaction payloads, the user's wallet signs/sends them, and the frontend may report only safe result metadata such as `tx_signature`.
- The backend MUST NOT request, receive, persist, or forward private keys or full signed transactions for user-executed critical actions.

### FR3 - Critical flow preservation

- Transfer approval MUST continue to validate the active pending action, expected wallet, action hash, policy/on-chain approval state, wallet-safety attestation, expiry, and guard readiness before returning an unsigned transaction.
- Guarded transfer behavior MUST remain compatible with existing on-chain enforcement expectations: policy, approval PDA, attestation PDA, recipient, amount, expiry, and replay protections.
- Swap approval MUST preserve the guardrail decision path, including a distinct `guard_rejected_awaiting_bypass` state when applicable.
- An unguarded swap after a guard rejection MUST require an explicit second approval with `accept_risk`; a model-generated statement MUST NOT count as risk acceptance.
- Conditional buy/order flows MUST preserve prerequisite funding behavior when required: after a signed funding result is reported and confirmed, the backend may create the conditional-order proposal.
- `function_reject` MUST safely cancel the active proposal and MUST NOT leave an approvable transaction artifact behind.
- `function_result` MUST record or continue conversation state only for the expected session, wallet, and proposal context.

### FR4 - Custom SSE protocol

- The initial migration MUST continue to emit the existing custom SSE events consumed by the frontend: `session`, `token`, `proposal`, `done`, and `error`.
- The backend MUST NOT switch to AI SDK UI message streams in the initial migration slice.
- Tool execution details from AI SDK MUST be translated into the existing Compass event contract before reaching the frontend.
- A `proposal` event MUST remain the only event that makes a critical action approvable in the UI.
- `done` MUST represent the end of a successful turn stream, and `error` MUST represent a terminal turn failure.
- Existing backend `alert` emissions MUST be resolved before declaring protocol stability: either the frontend contract formally supports typed `alert` events, or the backend converts those notices into supported event types.
- Streaming partial assistant text MUST NOT imply that a transaction has been validated, approved, or executed.

### FR5 - Read-only AI SDK tools and synthesis

- Holdings and USDC/SOL quote tools MAY execute through AI SDK tool primitives because they are read-only.
- Read-only tools MUST be backend-managed; the frontend and model prompt MUST NOT become sources of truth for balances or quotes.
- Read-only tool outputs sent to the model MUST be minimized to fields needed for the user's request.
- Read-only tool outputs MUST include freshness/source context when available, such as network, provider/source, timestamp, and quote-source metadata.
- The assistant MUST synthesize user-facing prose from read-only tool results rather than exposing raw JSON as the final answer, except when explicit debug output is requested and safe.
- If holdings or quote data cannot be resolved, the assistant MUST say that fresh data is unavailable and MUST NOT invent balances, prices, executable quantities, or guarantees.
- A read-only tool failure MUST NOT create, approve, execute, or mutate a critical proposal.

### FR6 - Critical intent detection through AI SDK

- Critical AI SDK tool schemas, if introduced, MUST be treated as intent schemas rather than executable side-effect tools.
- Critical intent arguments MUST be validated and normalized by Compass deterministic handlers before any proposal is created.
- If model-provided critical intent arguments are incomplete, ambiguous, malformed, or unsafe, the system MUST ask for clarification or return a safe error instead of creating an approvable proposal.
- Address masking/restoration behavior around model calls MUST be preserved so that wallet addresses are protected in prompts while deterministic handlers receive canonical addresses.
- Model-generated text MUST NOT override backend policy decisions, wallet safety results, on-chain guard readiness, proposal expiry, or user risk acceptance requirements.

### FR7 - Wallet/session ownership and history

- Sessions tied to a wallet MUST remain inaccessible for approval, rejection, result, or history operations from a different wallet.
- `get_history` behavior MUST continue to enforce wallet ownership for wallet-bound sessions.
- A rehydrated frontend conversation MUST NOT make an old pending proposal approvable unless the backend session still owns a live matching `pendingProposal` for the connected wallet.
- Wallet switch or disconnect behavior MUST NOT leak messages, session ids, or approvable proposals across wallets.

### FR8 - Optional per-user persistent sandbox scope

- Sandboxes MUST NOT be introduced merely as part of model-provider migration; they SHOULD be added only after a concrete product workflow requires file or command execution.
- If sandboxes are enabled, each sandbox MUST be scoped to one authenticated user owner and MUST be persistent across sessions for that owner.
- Sandbox names MUST be derived from a stable authenticated user identifier with server-side salting/hashing; raw wallet addresses, raw PII, and session ids MUST NOT be used as sandbox names.
- If no stable authenticated owner exists, the system MUST NOT create or resume a persistent sandbox.
- A salted, hashed verified wallet fallback MAY be used only when documented as lower confidence than an internal/Dynamic user id.
- Sandboxes MUST NOT contain private keys, wallet signing capabilities, production provider secrets, Vercel tokens, GitHub tokens, or backend custody authority.
- Sandboxes MUST NOT interact directly with Solana signing or custody flows.
- Sandbox tools MUST be explicit, allowlisted, rate/timeout/output limited, and deny-by-default for network egress unless a workflow explicitly requires allowlisted egress.
- Different authenticated users MUST NOT be able to read, resume, list, or execute commands in each other's sandboxes.

### FR9 - Privacy and secret handling

- Private keys, seed phrases, signed transactions, provider secrets, and infrastructure tokens MUST NOT be included in prompts, model tool inputs, model outputs, logs intended for model context, or sandbox state.
- Wallet portfolio data sent to the model MUST be minimized and MUST NOT be treated as public telemetry.
- Error messages SHOULD be clear and actionable without exposing secrets, internal credentials, or sensitive provider payloads.
- Logs and telemetry SHOULD preserve enough information to debug adapter behavior, tool routing, and proposal preservation without recording sensitive wallet/signing material.

## Acceptance Scenarios

### Scenario 1 - Existing custom SSE remains stable for a normal chat turn

Given a connected wallet and an ordinary non-transactional chat message
When the backend answers through the AI SDK runtime adapter
Then the frontend receives only supported custom SSE events such as `session`, `token`, and `done`
And the frontend does not need AI SDK `useChat` semantics to render the answer
And no proposal is created.

### Scenario 2 - Deterministic direct transfer parsing is preserved

Given a user asks a clear direct transfer request that the deterministic parser supports
When the message is processed during the initial migration
Then the backend routes the request through deterministic transfer handling
And the model does not autonomously execute a transfer tool
And any approvable outcome is emitted as a Compass `proposal` event only after guardrails pass.

### Scenario 3 - Model-detected transfer intent cannot bypass guardrails

Given the AI SDK runtime detects a structured transfer intent
When the intent reaches Compass backend orchestration
Then the backend validates wallet identity, recipient, amount, policy, wallet safety, guard readiness, hash, and expiry
And the backend emits a proposal only if deterministic validations allow it
And no unsigned transaction is returned until the user explicitly approves the proposal.

### Scenario 4 - Transfer approval remains self-custodial

Given a valid pending transfer proposal for the connected wallet
When the user approves it in the UI
Then the backend returns an unsigned transaction payload only after validating the pending proposal and guardrail state
And the frontend asks the wallet to sign and send
And the backend never receives a private key or signed transaction for execution.

### Scenario 5 - Wallet mismatch blocks sensitive actions

Given a pending proposal was created for Wallet A
When Wallet B attempts `function_approve`, `function_reject`, `function_result`, or wallet-bound `get_history`
Then the backend rejects the operation as not authorized or not found
And no proposal, unsigned transaction, or cross-wallet history is exposed.

### Scenario 6 - Expired or replaced proposal cannot be approved

Given a proposal has expired, was rejected, was executed, or is no longer the active `pendingProposal`
When the frontend sends `function_approve`
Then the backend returns a clear failure reason
And no unsigned transaction is returned
And the UI treats the proposal as non-approvable.

### Scenario 7 - Swap guard rejection requires explicit second approval

Given a swap intent fails guardrails but is eligible for user risk bypass
When the backend enters `guard_rejected_awaiting_bypass`
Then the UI must show the risk state and require explicit `accept_risk`
And the backend must not prepare the unguarded transaction from model text alone
And only a second explicit approval may continue the unguarded path.

### Scenario 8 - Conditional order funding prerequisite is preserved

Given a conditional buy requires a devUSDC funding swap proposal first
When the user signs/sends the funding transaction and reports the result
Then the backend validates the result in the expected session and wallet context
And only then may it create the conditional-order proposal
And the model cannot skip directly to conditional execution.

### Scenario 9 - Holdings read-only tool produces synthesized prose

Given a user asks what assets they hold
When the AI SDK runtime invokes the backend-managed holdings tool
Then the tool reads wallet holdings from backend sources
And the model receives only minimized, relevant holdings data with freshness/network context
And the final assistant answer is natural-language prose grounded in those tool results.

### Scenario 10 - Quote read-only tool reports source and freshness

Given a user asks how much SOL they could get for a USDC amount
When the backend-managed quote tool returns a devnet USDC/SOL quote
Then the assistant response includes that it is a quote, not an execution guarantee
And the response reflects source/freshness metadata when available
And no swap proposal is created unless the user asks to perform a swap and guardrails pass.

### Scenario 11 - Read-only data failure does not hallucinate

Given the holdings or quote provider fails, times out, or returns inconsistent network/mint data
When the assistant responds
Then it states that fresh data is unavailable or incomplete
And it does not invent balances, prices, routes, or executable amounts
And it does not create a critical proposal from failed read-only data.

### Scenario 12 - Malformed critical tool arguments are safe

Given the model emits critical intent with an invalid address, missing amount, ambiguous token, unsupported network, or unsafe slippage
When the backend validates the intent
Then it asks for clarification or returns a safe error
And it does not emit an approvable proposal
And it does not call transaction-preparation services.

### Scenario 13 - Existing `alert` emissions are protocol-safe

Given a conditional funding path needs to notify the frontend
When the backend emits the turn stream after migration
Then the notice is represented either as a formally supported typed `alert` event or as supported `token`/`proposal` metadata
And the frontend parser does not silently ignore a safety-relevant message.

### Scenario 14 - Provider compatibility no-go preserves current behavior

Given the AI SDK cannot safely target the selected provider path
When compatibility would require frontend protocol changes, secret exposure, or guardrail weakening
Then the migration slice is halted or rolled back at the adapter seam
And existing Azure Responses bridge behavior remains available.

### Scenario 15 - Sandbox requires authenticated owner

Given sandbox support is enabled for a specific product workflow
When a user without a stable authenticated owner attempts to use sandbox-backed capabilities
Then the system refuses to create or resume a persistent sandbox
And returns a clear authentication/ownership requirement.

### Scenario 16 - Same user resumes same sandbox, different users are isolated

Given User A has an authenticated stable owner id
When User A uses sandbox-backed workflow across multiple sessions
Then the same salted/hashed persistent sandbox is resumed
And when User B uses the same workflow
Then User B receives a different sandbox and cannot access User A's files, process state, or command outputs.

### Scenario 17 - Sandbox cannot sign or access secrets

Given a model-generated sandbox command attempts to read secrets, access wallet keys, sign a Solana transaction, or call unrestricted network endpoints
When sandbox policy evaluates the request
Then the request is denied or constrained by allowlisted tools
And no custody, signing, or production secret material enters the sandbox.

## Edge Cases

- The AI SDK streams text after a proposal has already been emitted: the UI MUST still treat the `proposal` event and backend state as the source of truth for approvability.
- The model emits multiple critical intents in one turn: the backend MUST create at most one active proposal or ask the user to choose one action.
- The user asks for holdings and then says "do it": the backend MUST resolve a fresh critical intent and run guardrails; a prior read-only answer is not approval.
- The user changes wallet during streaming: sensitive follow-up actions MUST be blocked unless the backend session and connected wallet still match.
- A tool result arrives after the session expires: it MUST NOT create or update an approvable proposal.
- Quote freshness expires between answer and approval: the backend MUST revalidate quote/guardrail conditions before transaction preparation.
- A sandbox snapshot expires: the system SHOULD recreate or rebootstrap only for the authenticated owner and MUST explain lost workspace state if user-visible.
- A provider returns malformed model output or invalid tool-call shape: the adapter MUST fail closed for critical flows and avoid partial proposal mutation.
- Address masking fails to restore a model-provided address confidently: the backend MUST not create a critical proposal from that address.
- Frontend history rehydrates an old proposal card: approval MUST be disabled unless backend `get_history` confirms the live pending proposal for the same wallet.

## Acceptance Criteria

- The first migration slices keep `/api/chat` and custom SSE compatible with current frontend behavior.
- Critical transfer, swap, conditional-order, and funding flows still require explicit user approval and wallet signature.
- Critical tool detection through AI SDK cannot execute side effects and must route through deterministic Compass handlers.
- Read-only holdings and quote tools can execute server-side and produce synthesized, grounded assistant answers.
- Failed read-only tools produce clear non-hallucinated responses and do not mutate proposal state.
- Wallet/session ownership, one-active-proposal semantics, expiry handling, and result recording remain enforced.
- Optional sandbox functionality is conditional, per authenticated user, isolated, secret-free, and non-custodial.
- The migration has a clear rollback/no-go path if AI SDK provider compatibility conflicts with Compass guardrails or protocol stability.
