# Verify — wiring the judge + mandate (the seam)

> **Status: DRAFT / proposal — the FORWARD design for a seam the shipped `/verify` deliberately leaves open. NOT yet built.**
> The current `POST /v1/verify` is **deterministic-only** (policy + counterparty screening). This doc specifies how the **LLM judge** and the **owner mandate** get wired into it, building on [judge-unblinding](../judge-unblinding/proposal.md). Drafted 2026-07-19, grounded in a read of `hosted/verify/`.

## What's shipped today (the baseline this builds on)

`POST /v1/verify` (`hosted/verify/`) is **deterministic** — the code says so explicitly: *"No LLM router, no LLM judge."*

- classify tool → `derivePolicyContext(intent.kind, args)` → `evaluateAction` (default policy)
- **counterparty screening** (`applyTrustSignal`) — negative evidence only; can push a decision toward *deny*, never relax it
- stores an `intendedEffect { actionKind, recipient, amountUsd }` + a `DECIDED` verdict, returns a `correlationId`
- **two-phase:** `/verify` decides → `/verify/confirm` compares **actual vs intended** effect (`compareEffects` / `deriveActualEffect`) — post-execution verification, **already built**

Two facts from the code that define the seam:
- the request `intent` is only `{ kind: "transfer" | "swap" }` — the **action kind**, not an owner mandate; there is **no mandate anywhere in `/verify`**.
- the native `intendedEffect` dimensions (lamports / token amount / mint) are an explicit **SEAM**, populated *"once a verify-side decode source (Fran's `decodeTransaction`) is wired. There is no such source in verify today."*

## The gap this closes

The deterministic path catches **structural** violations (caps, denylist, drainer recipients via screening). It **cannot** catch *"within caps but outside the owner's mandate"* — the headline case — because (a) it never decodes/simulates the real tx (it runs on args/`intent.kind`, i.e. self-report), and (b) there is **no mandate** to judge against. That is the [judge-unblinding](../judge-unblinding/proposal.md) problem, applied to the `/verify` surface.

## The design — three additions

1. **Register the mandate (the trusted anchor).** `POST /v1/mandate { userId | agentId, mandate }` — the owner's policy (natural-language intent + structured caps/allowlist). `/verify` looks it up **by identity**; it is **not** sent per call. This is the trusted anchor the judge compares against. *(Prerequisite — see design rule 2.)*
2. **Carry the stated intent.** Extend the request `intent` beyond `{ kind }` to also carry the caller's **stated action/context** (the *untrusted* claim, e.g. "pay vendor Acme for invoice #42"). Keep `kind` for the deterministic fast-path.
3. **Decode + simulate + judge.** Wire the decode source (Fran's `decodeTransaction`) so `/verify` fills the real `intendedEffect` dimensions, then run the judge pipeline from [judge-unblinding](../judge-unblinding/technical-spec.md): **Tier-1 deterministic deny → decode+simulate → Tier-2 deterministic deny (on ground truth) → LLM judge (owns approve) on decoded + sim effects + mandate.** The existing deterministic path **becomes** the Tier-1/Tier-2 tiers — this extends it, it does not replace it.

The judge then reasons over the **triad**:

| Input | Trust | Source in `/verify` |
|---|---|---|
| **Stated intent** | untrusted | passed in the request (addition 2) |
| **Mandate** | trusted | registered up front, looked up by identity (addition 1) |
| **Real tx effect** | ground truth | decode + simulate (addition 3) |

## Degraded modes (honest — mirrors the code's fail-closed posture)

- **Full** (mandate registered + intent passed + decode available) → intent-vs-mandate judging.
- **No mandate / no intent / no decode source** → falls back to **today's deterministic decision** (exactly current behaviour — nothing regresses).
- Return an **`intent_source: full | self_report | none`** field so the caller *and* the verdict record know which check actually ran — same spirit as the existing `flags.__source = "self_report"` degraded flag in the judge pipeline. Never silently present a structural-only check as a mandate check.

## Two design rules

1. **Advisory unless bound.** `/verify` returns a *decision*; it only **enforces** if the caller refuses to act on a `deny` (wired into their signing path). For partners, make *"can't proceed on a deny"* the integration contract — otherwise `/verify` is advisory, not a veto. (Same observe-vs-veto axis as the MCP proxy.)
2. **The mandate makes it possible.** Without a registered mandate there is no *intent-vs-mandate* — only structural checks. Mandate registration is the **prerequisite**, not optional decoration; it is what turns `/verify` from a policy filter into a mandate judge.

## How it composes with what's built

- **Extends, doesn't replace** the deterministic `/verify` — that stays as the cheap Tier-1/Tier-2.
- **Reuses** the `verify → confirm` two-phase for post-execution effect-compare (already built).
- **Wires** the judge-unblinding pipeline into the `/verify` decision path.
- **Fills** the `intendedEffect` decode SEAM the code already names.

## Ownership

- `/verify` endpoint surface + deterministic path — verify-endpoint workstream.
- The judge behind it — CTO (per [judge-unblinding](../judge-unblinding/technical-spec.md): *Owner: judge workstream (CTO)*).
- The decode source (`decodeTransaction`) — Fran.

---

*This is a forward/seam design, not as-built. The shipped `/verify` is deterministic + counterparty-screening + intended/actual effect-compare; the judge + mandate above are the next step, gated on the decode source landing.*
