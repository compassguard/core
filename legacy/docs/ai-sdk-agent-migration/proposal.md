# Proposal: migrate Compass agent to Vercel AI SDK with per-user persistent sandboxes

Compass should migrate the current custom Azure Responses agent bridge to a Vercel AI SDK-based model/tool runtime while preserving the existing guardrail-first transaction lifecycle. The migration should be adapter-first: replace the model/tool-call seam before changing the frontend chat protocol or transaction approval flow.

## Decision summary

| Area                  | Proposal                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration shape       | Adapter-first, not UI-first. Keep `/api/chat` contract stable in the first migration slice.                                                        |
| Agent runtime         | Introduce an AI SDK model/agent adapter around the existing backend chat service.                                                                  |
| Deterministic intents | Preserve deterministic pre-parsers, especially direct transfer intent, until a later slice proves AI SDK intent detection is safer.                |
| Critical tools        | Keep transfer/swap/conditional-order proposal and approval deterministic server-side. Do not let an autonomous tool loop execute critical actions. |
| Read-only tools       | Convert holdings and quote tools to AI SDK tools that can execute and synthesize follow-up text.                                                   |
| Sandboxes             | Add Vercel Sandbox as an isolated per-user workspace, persistent by default, never as a signing/custody environment.                               |
| Frontend              | Keep current custom SSE events initially; evaluate `useChat` only after backend behavior is stable.                                                |
| Review strategy       | Single PR default with reviewable slice commits; splitting remains advisory if implementation scope becomes hard to review.                        |

## Current baseline

The current `/api/chat` architecture is not an active LangGraph graph in practice.

```txt
front/src/hooks/useAgentMessage.ts
  -> front/src/lib/api/client.ts
    -> app/api/chat/route.ts
      -> back/services/chat.ts
        -> back/services/azureResponsesClient.ts
          -> Azure OpenAI Responses API
```

Important existing behavior to preserve:

- `app/api/chat/route.ts` is a thin Next route handler.
- `back/services/chat.ts` owns model calls, tool routing, proposal creation, approval handling, result handling, and SSE emission.
- `back/services/chat.ts` also short-circuits simple transfer requests through a deterministic `parseDirectTransferIntent` path before calling the model.
- `back/services/chatSessionStore.ts` stores transcript and one active `pendingProposal` per session, with TTL and optional Redis/Upstash/Vercel KV persistence.
- The frontend consumes custom SSE events: `session`, `token`, `proposal`, `done`, `error`.
- The backend currently emits `alert` in some conditional funding paths, but the frontend parser ignores it; the migration should either formalize `alert` or convert those notices to supported events.
- Approval/result/reject/history are JSON request types on the same `/api/chat` endpoint.
- Critical transactions are prepared by the backend, signed by the user's wallet in the frontend, and optionally reported back by `function_result`.

## Goals

1. Replace custom model-provider code with Vercel AI SDK primitives.
2. Preserve existing guardrails, proposal states, wallet-bound sessions, and self-custodial signing.
3. Enable multi-step, tool-aware answers for read-only context such as holdings and USDC/SOL quotes.
4. Define the safe path for one persistent sandbox workspace per authenticated user, then add it only after a concrete product workflow needs file/command execution.
5. Keep migration reviewable and reversible through narrow slices.

## Non-goals

- Do not migrate the frontend to AI SDK `useChat` in the first slice.
- Do not remove backend guardrail enforcement.
- Do not put private keys, wallet signing, provider secrets, or Vercel/GitHub tokens inside sandboxes.
- Do not let model-generated code interact directly with Solana custody/signing.
- Do not make LangGraph removal the first change unless unused imports/deps are already isolated and tested.

## Proposed architecture

### 1. Add an agent model adapter

Introduce a backend adapter that hides the model provider and AI SDK details from `back/services/chat.ts`.

Suggested shape:

```txt
back/services/agentRuntime/
  modelClient.ts        # model call interface used by chat.ts
  aiSdkModelClient.ts   # Vercel AI SDK implementation
  toolDefinitions.ts    # shared tool declarations/schemas
  types.ts              # provider-neutral result types
```

The adapter should expose provider-neutral operations, for example:

```ts
type AgentRuntime = {
  detectToolIntent(input: AgentInput): Promise<ToolIntent | null>;
  streamText(input: AgentInput): Promise<ReadableStream<AgentTextDelta>>;
  runReadOnlyTurn(input: AgentInput): Promise<AgentTextResult>;
};
```

This keeps `chat.ts` responsible for Compass product behavior while the adapter owns AI SDK provider mechanics.

### 2. Preserve critical action lifecycle

Critical tools should not become ordinary auto-executed tools.

| Tool                    | AI SDK behavior     | Compass behavior                                                                          |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `transfer`              | Detect intent only  | Backend validates, creates proposal, waits for user approval/signature.                   |
| `conditional_buy_sol`   | Detect intent only  | Backend validates condition/order params, creates proposal, waits for approval/signature. |
| `swap_orca_usdc_to_sol` | Detect intent only  | Backend quotes/checks guardrails, creates proposal, handles guard bypass if needed.       |
| `get_wallet_holdings`   | Execute server-side | Safe read-only tool; result can feed a second model step.                                 |
| `get_usdc_sol_quote`    | Execute server-side | Safe read-only tool; result can feed a second model step.                                 |

For critical tools, the model can propose structured intent, but deterministic Compass code must own:

- wallet identity checks,
- policy checks,
- safety scoring,
- on-chain guard readiness,
- proposal state,
- unsigned transaction construction,
- expiry/hash validation,
- result recording.

Existing critical-flow details to preserve:

- Transfer approval validates the pending action hash, expected wallet, policy PDA, wallet-safety attestation, and guard readiness before returning an unsigned transaction.
- Swap approval can enter `guard_rejected_awaiting_bypass`; only an explicit second approval with `accept_risk` may build the unguarded transaction.
- Conditional buy may first require a devUSDC funding swap proposal; after the signed funding result is confirmed, the backend creates the conditional-order proposal.
- Frontend signing remains self-custodial: backend returns unsigned payloads, the wallet signs/sends, then the frontend reports `function_result`.

### 3. Keep the existing frontend protocol first

Phase 1 should continue returning the existing event contract:

```txt
event: session
event: token
event: proposal
event: done
event: error
```

Protocol cleanup note: backend `alert` emissions must be resolved before declaring the protocol stable. Either add typed `alert` handling to the frontend schema/parser or emit these notices as supported `token`/`proposal` metadata.

Why:

- `front/src/hooks/useAgentMessage.ts` already coordinates wallet signing and proposal state.
- Proposal cards depend on current Zod schemas and custom state transitions.
- AI SDK UI message streams encode tools differently; switching immediately would couple model migration with UI/state migration.

A later phase can evaluate AI SDK `useChat` if it provides enough benefit after backend semantics are stable.

### 4. Add persistent per-user sandboxes

Use Vercel Sandbox as an isolated workspace for agent workflows that need filesystem or command execution.

Recommended lifecycle:

```ts
const sandbox = await Sandbox.getOrCreate({
  name: stableUserSandboxName,
  runtime: "node24",
  snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
  onCreate: async (sandbox) => {
    // one-time workspace bootstrap
  },
  onResume: async (sandbox) => {
    // restart background services or rehydrate lightweight state
  },
});
```

Sandbox naming rules:

- Derive the name from authenticated user identity, not raw wallet address.
- Prefer `dynamicUserId` or internal app user id plus a server-side salt/hash.
- If no stable authenticated owner exists, do not create or resume a sandbox.
- A verified wallet-address fallback is allowed only if it is salted and hashed server-side, durable across sessions, and explicitly treated as lower confidence than an internal user id.
- Do not use session ids as the primary sandbox identity; sessions expire, sandboxes persist.
- Do not include secrets or personally identifying raw wallet strings in the sandbox name.

Suggested service boundary:

```txt
back/services/sandbox/
  userSandbox.ts       # get/create/resume by authenticated user
  sandboxTools.ts      # safe command/file tools exposed to AI SDK
  sandboxPolicy.ts     # allowlists, limits, network/resource policies
```

### 5. Treat sandbox as workspace, not authority

Sandboxes can run untrusted or model-generated commands, so they must be less privileged than the main backend.

Rules:

- No wallet signing inside sandbox.
- No private keys inside sandbox.
- No provider API keys inside sandbox unless a future feature explicitly requires a scoped, revocable, non-custodial token.
- No direct access to production backend secrets.
- Restrict commands through explicit tools, not raw arbitrary shell access by default.
- Set timeouts, output limits, storage limits, and cleanup/snapshot expiration.
- Use network egress deny-by-default; allowlist egress only for workflows that explicitly require it.

## Implementation slices

### Slice 1: Provider compatibility spike

Purpose: prove AI SDK can call the intended model path without changing product behavior.

Tasks:

- Add minimal AI SDK dependency in a branch.
- After installing `ai`, verify current APIs from `node_modules/ai/docs/` and `node_modules/ai/src/`; do not rely on stale examples.
- Verify whether AI SDK can target the current Azure Responses `/openai/responses` setup using `OPENAI_CHAT_MODEL` plus `OPENAI_RESPONSES_ENDPOINT`/`OPENAI_API_URL`, or choose AI Gateway as provider path.
- Create a tiny backend-only spike for plain text generation.
- Do not modify frontend contract.

Exit criteria:

- One backend test proves model adapter config resolution.
- One mocked test proves `chat.ts` can call through adapter shape.
- Decision recorded: Azure-compatible AI SDK provider vs AI Gateway migration.
- Rollback/no-go criteria recorded: if provider compatibility requires weakening guardrails, changing frontend protocol, or exposing secrets, keep the existing Azure Responses adapter and stop the migration slice.

### Slice 2: Adapter extraction

Purpose: remove direct dependency on `azureResponsesClient.ts` from chat orchestration.

Tasks:

- Create provider-neutral runtime interface.
- Move current Azure Responses behavior behind the adapter first.
- Keep tests passing before swapping implementation.

Exit criteria:

- Current behavior unchanged.
- Existing chat tests can mock the adapter instead of Azure client internals.

### Slice 3: AI SDK read-only tool loop

Purpose: improve holdings/quote answers with real tool results and model synthesis.

Tasks:

- Convert read-only tools to AI SDK `tool({ inputSchema, execute })`.
- Replace the current raw-JSON-as-`token` behavior with model-synthesized prose based on backend tool results.
- Enable controlled multi-step generation only for read-only tools.
- Minimize wallet portfolio data sent to the model: send only fields needed for the user request, include freshness/source context, and avoid unnecessary full holdings dumps.
- Keep critical tools as intent/proposal flow.

Exit criteria:

- Asking for wallet holdings returns natural-language answer based on backend tool result.
- Asking for quote returns natural-language answer with freshness/source context.
- No transaction proposal state regression.

### Slice 4: Critical tool intent migration

Purpose: let AI SDK detect critical action intent without owning execution.

Tasks:

- Convert critical tool schemas to AI SDK-compatible structured intent.
- Route detected intent into existing deterministic handlers.
- Preserve address masking/restoration behavior around model calls.

Exit criteria:

- Transfer, swap, and conditional buy proposals match current schemas.
- Approval/result/reject flows remain unchanged.
- Guardrail and expiry tests pass.

### Slice 5: Per-user persistent sandbox service

Purpose: add isolated user workspaces safely if the product workflow requires filesystem or command execution.

Tasks:

- Confirm the first product workflow that needs sandbox filesystem or command execution.
- Add `@vercel/sandbox` integration behind `userSandbox` service.
- Use stable hashed authenticated user names.
- Add sandbox policy: timeouts, command allowlist, output limits, snapshot expiration.
- Add initial read/write/list or command tools only if needed by the target product flow.

Exit criteria:

- Same authenticated user resumes same sandbox.
- Different users cannot access each other's sandbox.
- No secret values are written into sandbox setup.
- Sandbox lifecycle can be tested/mocked locally.

### Slice 6: Optional frontend protocol migration

Purpose: evaluate AI SDK UI after backend migration is stable.

Tasks:

- Compare current custom store/proposal UI against `useChat` typed tool parts.
- Decide whether typed AI SDK UI messages reduce code or increase coupling.
- Migrate only if approval/signature UX remains clear.

Exit criteria:

- Explicit decision: keep custom SSE or migrate to `useChat`.
- No hidden changes to transaction signing semantics.

## Test impact map

Backend tests likely to change or receive new coverage:

- `back/services/__tests__/chat.test.ts` for adapter mocking, tool routing, address masking, direct transfer parsing, session ownership, approval/result/reject flows, and proposal preservation.
- Adapter/config tests replacing or wrapping `azureResponsesClient` coverage.
- Existing domain tests around conditional buy, Orca swap, on-chain approval, wallet safety validation, holdings, and quotes.

Frontend tests likely to guard the stable protocol:

- `front/src/lib/api/__tests__/client.test.ts` and schema tests for SSE parsing, including the `alert` cleanup decision.
- `front/src/hooks/__tests__/useAgentMessage.test.tsx` for proposal approval, wallet signing, result callbacks, and guard-bypass flows.
- Chat store/proposal card tests for proposal state transitions.

## Risks and mitigations

| Risk                                                           | Mitigation                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AI SDK provider mismatch with current Azure Responses endpoint | Run provider compatibility spike first. Keep old adapter until replacement passes tests.                                           |
| Tool loop auto-executes critical actions                       | Critical tools return intent/proposal only; deterministic handlers own all side effects.                                           |
| Frontend protocol migration breaks approval UI                 | Keep custom SSE first; migrate UI later only with separate proposal.                                                               |
| Sandbox leaks secrets                                          | Never mount secrets into sandbox; use allowlisted tools, scoped policies, and deny-by-default network egress.                      |
| Model receives sensitive portfolio data                        | Minimize read-only tool outputs, redact unnecessary holdings, and include only request-relevant wallet context.                    |
| Sandbox cost grows due to persistence                          | Set snapshot expiration, quotas, cleanup policy, and user-level limits.                                                            |
| User identity drift creates multiple sandboxes                 | Use authenticated internal/Dynamic user id, not wallet/session id.                                                                 |
| Address masking regressions                                    | Preserve masking/restoration tests around model input and tool args.                                                               |
| Large PR review burden                                         | Keep slice commits and rollback checkpoints visible; suggest splitting only as an advisory if review scope becomes hard to follow. |

## Open questions

1. Should the first production provider be AI Gateway or the current Azure OpenAI deployment through AI SDK?
2. Which durable user identity should become the canonical sandbox owner: Dynamic user id or another internal app user id?
3. What product workflows actually need sandbox filesystem/command execution in the first release?
4. Which sandbox workflows, if any, require allowlisted network egress under a deny-by-default policy?
5. How long should persistent snapshots live for inactive users?
6. Should sandbox tools be exposed to the same Compass chat agent, or to a separate "workspace agent" mode?

## Acceptance criteria for the migration program

- Existing transfer/swap/conditional-order proposal and approval flows remain compatible with current frontend schemas.
- Critical actions still require explicit user approval and wallet signature.
- Read-only tools can produce natural-language answers using backend-managed data.
- If sandbox scope is approved, each authenticated user can resume the same sandbox workspace across sessions.
- No secret/key material is read into prompts, sent to the model, or written into sandbox state.
- Wallet portfolio data sent to the model is minimized to the user's request and never treated as public telemetry.
- Backend tests cover adapter behavior, tool routing, proposal preservation, and sandbox ownership.

## Recommended next step

Start with **Slice 1: Provider compatibility spike**. It is the smallest safe move because it answers the main unknown: whether AI SDK can replace the current Azure Responses bridge directly, or whether Compass should route through AI Gateway first.
