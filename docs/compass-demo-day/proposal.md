# Compass — Demo-Day Build Plan (mid-July)

> **Status: DRAFT / proposal — shared for discussion, not yet the official plan.**
> Updated: 2026-06-24. Grounded in a read of this repo @ `release/compass_migration`.
> Scope note: this plan covers everything *around* the judge — the judge itself
> (un-blinding, model, structured output, intent-vs-mandate logic) is owned by a
> separate workstream and only meets this plan at the [handoff contract](#judge-handoff-contract).

*~3 weeks out (today: 2026-06-24). What's needed to get to a demo, **excluding the judge**. This doc covers everything around it.*

## Scope

**In scope:** plug & play install, demo readiness (real devnet downstream, approval path, client verification), durable verdict store, validation evidence that doubles as demo assets, demo assembly.

**Out of scope (separate workstream — "judge"):** un-blinding the judge to intent/mandate, model selection + structured outputs, letting it arbitrate intent-vs-amount, judge reliability/determinism. This plan only touches the **integration points** with the judge (the on/off flag, the hosted inference wiring, and the verdict schema the store persists) — see [Judge handoff contract](#judge-handoff-contract).

## Starting line (current code state)

Grounded in the repo, so this is **hardening + evidence, not building from scratch**:

- **P1 MCP proxy — REAL**, shipped to npm (`@ramadan04/compass-mcp-guard`), `tools/list` passthrough + `tools/call` interception, fail-closed, 312 tests.
- **Policy/classification engine — REAL** (caps, allowlists, `authority_change`/`unlimited_delegate` deny flags, tool risk classes).
- **P3 co-signer / on-chain — REAL but ORPHANED** (devnet Anchor programs + verifier exist, not wired into the live path; proxy is pure passthrough). *Not needed for this demo — leave orphaned.*
- **Audit store — in-memory `Map`** (wiped on restart, omits amount/recipient/rationale). Must become durable (WS2).
- **Demo path — runs vs a MOCK downstream**, needs a live external LLM, flaky; the 3 canonical Claude/Cursor scenarios are still unchecked in `docs/MVP_CHECKLIST.md`.
- **Judge — off by default**, blind to intent. (Separate workstream.)

## What the demo must show

> A real agent in Claude/Cursor → a **real devnet Solana MCP** behind Compass → an action that **caps would pass but is outside the owner's mandate** gets stopped, with a plain-English reason — and it's backed by **real, on-chain §01 evidence** that this attack class is real.

The *blocking decision itself* is the judge's job (separate workstream). **This plan delivers everything around it** so that the moment the judge lands, the demo is whole: the install, the real downstream, the approval surface, the durable verdict trail, and the problem-is-real evidence.

## Workstream 1 — Plug & play

Goal: a stranger can install Compass in one client with a copy-paste block, and the smart path works without local LLM config.

- [ ] **Stable hosted endpoint.** Replace the one-off Vercel *preview-hash* URL + shared hardcoded key with a production URL and a key a fresh installer can actually use. *(today: `solanahackathon-…vercel.app` + `compass-hc-…`)*
- [ ] **Server-side inference wiring** (integration point with judge workstream). The judge runs in the hosted backend so the user configures **no LLM locally** — this plan owns the on/off flag default + the hosted call path; the judge workstream owns what runs inside it.
- [ ] **Approval channel — real gap, must-have.** Decide where `REQUIRE_APPROVAL` surfaces in Claude/Cursor. Today a raw npx+client setup has no UI for it, so it likely soft-dead-ends. Pick one: local web/CLI approval prompt, or an "approve" tool the agent relays. **Demo scenario 2 (transfer → approve → proceeds) is dead without this.**
- [ ] **One verified copy-paste config block per client**, documented in the README.
- [ ] *(nice-to-have)* **Downstream presets** — `--protect solana-agent-kit` alias instead of hand-written `--downstream-command/--downstream-args-json` JSON.
- [ ] *(nice-to-have)* **Fresh-install fallback** — today a failed hosted call = fail-closed DENY = "nothing works"; decide a sane default or a clear error.

## Workstream 2 — Demo readiness

Goal: the demo runs on real (devnet) transactions, reliably, in one client.

- [ ] **Wire a real devnet Solana MCP as the downstream** (replace `scripts/test-downstream-mcp.mjs` mock). Candidate: Solana Agent Kit MCP / Phantom MCP on devnet.
- [ ] **Durable verdict store** (replace the in-memory `Map`). Persist **full context**: tool, **amount, recipient**, decision, risk, reasons, **mandate/intent**, rationale, timestamp. Two payoffs: (a) the demo can show the verdict dataset *accumulating* (the moat narrative), (b) it's the schema the judge writes into — define it here, see handoff contract. Storage: SQLite / Postgres / Vercel KV — whatever's fastest to ship.
- [ ] **Verify end-to-end in ONE client** (Claude **or** Cursor) with the 3 canonical scenarios (balance→ALLOW, transfer→APPROVAL, swap→DENY). Fix whatever breaks. *(these are the unchecked items in `docs/MVP_CHECKLIST.md`)*
- [ ] **De-flake the non-judge parts of the demo path** — stable downstream, deterministic scenario inputs. *(LLM-determinism is the judge workstream's concern.)*
- [ ] **Delete the stale `docs/wave-8-demo-hardening/runbook.md`** — it imports code deleted in wave 11; do not use it.

## Workstream 3 — Validation evidence

Goal: the demo's "problem is real" section, built from cheap instruments that **double as demo assets** and fill the validation plan's two open brackets (frequency, $ impact).

- [ ] **On-chain measurement harness** — count the failure-mode family (authority/approval changes, wrong-recipient, drained delegations) in agent-attributable Solana tx over N months. Output: the "problem proven, on-chain" slide **and** the validation plan's *frequency* + *quantifiable impact* numbers.
- [ ] **§01 case curation** — verify the five incidents (Grok/Bankr ~$175K, JaredFromSubway $7.5M, Lobstar Wilde $450K, malicious LLM routers $500K, Cursor) against sources; keep the dated, dollar-quantified table demo-ready.
- [ ] **GitHub demand harvest** — SAK issues #565 / #575 / #542 / #504 / #88 + independent spend-leash hacks (`onleash`, `@prflght/sak-plugin`, `up2itnow0822/agent-wallet-sdk`): counts, 👍, forks. Output: a revealed-demand slide.
- [ ] Interviews are the validation plan's job — **reference, don't duplicate** here.

> **Validation-gating:** per the problem-validation plan, the demo's headline scenario should follow what the on-chain harness + §01 show is the **real, frequent** failure mode — don't hard-code the ~$0 authority-change if the data says the live pain is wrong-recipient or something else. The three outcomes (Real-now / Real-not-yet / Not-real) still apply; the mid-July demo presents whichever is honest.

## Workstream 4 — Demo assembly & narrative

Goal: one rehearsed arc, with a fallback if the stage flakes.

- [ ] **The arc:** problem-proven (WS3) → live intercept on real devnet MCP (WS1+2) → verdict dataset accumulating (WS2 durable store) → the ask.
- [ ] **Decide live vs recorded** (depends on how reliable the live path is by week 3).
- [ ] **Record a fallback** walkthrough regardless, in case live devnet/LLM flakes on stage.
- [ ] Rehearse end to end.

## Build sequence (3 weeks)

Workstreams are largely independent — parallelize. The judge workstream lands in parallel and slots in via the handoff contract. (dev3pack Bridge timeline: Founder School to 9 Jul, **Demo Day & Selection 15–17 Jul**.)

**Week 1 (Jun 24–30) — foundations, all parallel:**
- WS1: stand up the stable hosted endpoint + key.
- WS2: wire the real devnet Solana MCP as downstream.
- WS3: on-chain harness + §01 curation.

**Week 2 (Jul 1–7) — make it usable + provable:**
- WS1: approval channel.
- WS2: durable verdict store + end-to-end client verification.
- WS3: GitHub harvest.
- *(judge workstream expected to land its on-by-default, intent-aware judge here)*

**Week 3 (Jul 8–14) — assemble + rehearse:**
- WS4: demo assembly, rehearsal, recorded fallback.
- Integration check with the judge workstream.

## Judge handoff contract

The clean interface so the two workstreams compose without stepping on each other.
The judge workstream — un-blinding the judge to the real tx (decode + simulate, intent-vs-mandate) — is
spec'd in [`docs/judge-unblinding/`](../judge-unblinding/proposal.md)
([technical detail](../judge-unblinding/technical-spec.md)). **It is demo-day-critical**: the headline
mandate-stop below is impossible without it, so the two workstreams share the mid-July deadline, not just the
interface.

**This plan provides TO the judge workstream:**
- The **durable verdict-store schema** (WS2) the judge writes into: `{tool, amount, recipient, mandate/intent, decision, risk, reasons[], human_explanation, timestamp, correlationId}`.
- The **hosted call path** + the **on-by-default flag** wiring (WS1) — the judge just needs to run inside it.
- The **demo scenario** the judge must reliably handle on stage (headline = whatever WS3 validates as the real failure mode; default candidate: the ~$0 authority/approval escalation, mapped to Grok/Bankr).

**This plan needs FROM the judge workstream:**
- The judge **on by default, server-side** (so plug & play delivers it with no local LLM config).
- A verdict in the **store schema shape** above (so WS2's durable store and the "dataset accumulating" demo work).
- Reliable enough for a **live demo** (the stage-flakiness fix is the judge workstream's, but the demo arc in WS4 depends on it).

## Exit criteria (demo-ready)

- [ ] `npx` install + one client config block verified working in Claude **or** Cursor.
- [ ] Real devnet Solana MCP wrapped; real (devnet) tx flow through Compass.
- [ ] `REQUIRE_APPROVAL` has a working human-approval path on stage.
- [ ] Durable verdict store persisting full context; demo shows it accumulating.
- [ ] §01 incidents verified with sources; on-chain failure-mode count produced (also fills the validation plan's two open brackets).
- [ ] Demo rehearsed; recorded fallback captured.
- [ ] *(judge: on-by-default, intent-aware, reliable — owned by the separate workstream; integration verified against the handoff contract.)*

## Appendix — Solana integration status (code audit, 2026-06-24)

The evidence behind the "P3 co-signer / on-chain — REAL but ORPHANED" line in [Starting line](#starting-line-current-code-state), broken out by the three on-chain concerns. Grounded in `release/compass_migration`. **Takeaway: the shipped MVP is an off-chain MCP guard; the on-chain layer is real, devnet-deployed Rust that is decoupled from the live decision path.** *Leave it orphaned for the demo — none of the gaps below are on the critical path.*

The `release/compass_migration` branch is a deliberate re-architecture (`docs/wave-3.5-legacy-isolation/`) from an old chat-app into the MCP-guard + hosted backend. The code that *submitted* on-chain transactions lived in a `legacy/` tree that **no longer exists on this branch** — which is why the on-chain programs are orphaned rather than wired.

The two Anchor programs themselves are non-trivial and devnet-deployed (IDs in `docs/onchain-deployments.md`):
- `back/solana/agent-action-guard/` — `UserPolicy`, `ActionApproval`, `WalletSafetyAttestation`, `AttestorConfig`; guarded SOL transfer via CPI; Pyth oracle-gated conditional execution; checked arithmetic + unit tests.
- `back/solana/conditional-escrow-buy/` — full USDC→SOL escrow with oracle price gating, treasury/vault PDAs, cancel/reclaim.

### 1. Request for approvals on chain — ⚠️ built on-chain, NOT wired into the live flow
- On-chain primitive is real: `ActionApproval` PDA (seed `["action_approval", user, action_hash]`), created by `create_action_approval`, with `revoke_action_approval` / `mark_executed` / oracle-conditional `mark_executed_if_price_below` (`agent-action-guard/.../src/lib.rs`).
- TS read/verify layer is real and good — `hosted/onchain/onchainApproval.ts` (~530 lines) derives the PDA, deserializes account bytes, checks executed/revoked/expired/recipient/amount/user (`verifyActionApproval`, `verifyTransferGuardReadiness`).
- **But it's never called in production:** `hosted/app.ts` wires only evaluate/audit/policies; the only callers of the verify functions are `back/services/__tests__/onchainApproval.test.ts`. No TS code *creates* an approval on-chain (that writer was in the deleted `legacy/`). And `AGENT_ACTION_GUARD_PROGRAM_ID` is **empty in `.env.example`**, so the read path returns `null` by default.

### 2. Audit of decisions on chain — ❌ not on-chain at all
- Audit is fully off-chain and **in-memory**: `hosted/audit/auditStore.ts` = `createInMemoryAuditStore()` (a `Map`, wiped on restart). Written via `POST /v1/audit/events`, read via `GET /v1/audits`.
- The evaluation service writes one entry per decision and **fails closed** if the write fails (`AUDIT_DEGRADED_DENIAL`) — so audit is treated as critical, but it's process memory, not a chain record. Neither Anchor program has an audit/event-log account.
- This is exactly the **WS2 "durable verdict store"** gap — the in-memory `Map` also omits amount/recipient/rationale.

### 3. Policies of each user — ⚠️ per-user on-chain in the contract; single global policy in the running product
- On-chain there *is* a per-user policy: `UserPolicy` PDA (seed `["user_policy", user_pubkey]`) with `initialize_policy` / `update_policy` and caps (`max_transfer_lamports`, `max_swap_usd`, `max_slippage_bps`, `allow_private_actions`, `enabled`); the on-chain instructions enforce it.
- The **live engine uses one hardcoded global policy** — `DEFAULT_POLICY` (`hosted/policy/defaultPolicy.ts`, `policy_id: "default-conservative"`). `loadDefaultPolicy()` is cached and identical for all users; every gateway (transfer/swap/conditional) + `evaluationService` feeds it into `policyEngine.evaluateAction`. Nothing reads the on-chain `UserPolicy`; `userId` on the request is used only for audit/telemetry, not policy selection.

### Status summary

| Concern | On-chain program | Live pipeline uses it? |
|---|---|---|
| Approvals (`ActionApproval`) | ✅ written, devnet-deployed | ❌ verify-only, in tests; no creator; gated off by empty env |
| Audit of decisions | ❌ no on-chain account | ❌ in-memory off-chain only (→ WS2) |
| Per-user policies (`UserPolicy`) | ✅ written | ❌ engine uses one global default |

`conditional-escrow-buy` is likewise orphaned: `back/services/domains/conditional-parking-lot/conditionalGateway.ts` has **zero** on-chain references — it too runs pure off-chain policy.

**To make any of these real end-to-end** (post-demo, not needed for mid-July): (a) re-introduce TS that *creates* `ActionApproval`/attestation txns and call `verifyTransferGuardReadiness` from the gateway before signing; (b) the WS2 durable (ideally hash-anchored) audit store; (c) load each user's on-chain `UserPolicy` into `evaluateAction` instead of the global default.
