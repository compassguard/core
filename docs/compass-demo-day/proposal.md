# Compass — Demo-Day Build Plan (mid-July)

> **Status: revised to the ratified veto/co-sign architecture (team-agreed 2026-07-02).** Supersedes the earlier MCP-proxy-enforcement draft. Grounded in a read of this repo @ `release/compass_migration`.

*Updated **2026-07-02** — revised to the **ratified veto/co-sign architecture**. ~2 weeks to Demo Day (15–17 Jul).*

> **Architecture (ratified 2026-07-02):** enforcement is a **withheld co-signature**, not an MCP-proxy block. The agent's funds live in a **dedicated Squads allowance account** that requires **Compass's co-signature**; the **judge** decides whether to co-sign. The **MCP proxy is demoted to an intent sensor** feeding the judge. **Non-custodial:** Compass holds a **veto key, never a spend key** — it can block, never spend alone. **v1 = co-sign (Squads); v2 = program-gated PDA** (attestation-only, post-demo endgame). Code: `ram4-dev/solana_hackathon` @ `release/compass_migration`.

## Why this changed (the veto pivot)

The MCP proxy is **bypassable**: an agent that holds its own key signs locally and never calls the proxy, so an observe/proxy layer can *see* but can't *stop* it. Per the custody research (de-biased run), **holds-own-key is the dominant model and is structurally entrenched on Solana** — so the only way to stop such an agent is to **be a required participant in the signature.** Enforcement therefore moves from the proxy to the **co-signature**, and the once-orphaned on-chain co-signer becomes the **spine.** The proxy isn't thrown away — it's repositioned as the intent sensor that makes the judge smart.

## Scope

**In scope:** the **co-sign custody spine (v1)**, provision-custody install, demo readiness on real devnet, durable verdict store + the **decision flywheel**, validation evidence, demo assembly.

**The judge (separate workstream — now central):** the judge is the decision-maker *at co-sign time* — it decides whether Compass **withholds its signature**. Owned by the judge-unblinding workstream; this plan owns the **co-sign integration point** (the judge's verdict gates the signature) + the verdict schema. See [Judge handoff contract](#judge-handoff-contract).

**Out of scope for the demo:** the **v2 PDA** (program-gated, attestation-only — Compass holds *no* fund-moving key; on-chain caps survive a Compass compromise) is the **endgame, post-demo**. MPC / custodial relay / TEE-custody (liability — see [Liability ceiling](#liability-ceiling)). EVM adapter (Solana-first; the chain layer is a swappable adapter).

## Starting line (current code state)

Grounded in the repo — **hardening + wiring, not building from scratch**:

- **P1 MCP proxy — REAL**, shipped to npm (`@ramadan04/compass-mcp-guard`), `tools/list` passthrough + `tools/call` interception, 312 tests. **Repositioned as the *intent sensor*** (captures the rich tool call for the judge) — **no longer the enforcement point.**
- **Policy/classification engine — REAL** (caps, allowlists, `authority_change`/`unlimited_delegate` deny flags) = the **deterministic tripwire zone** of the decision.
- **Co-signer / on-chain — REAL, and NOW THE SPINE** (was "orphaned — leave it"). devnet Anchor programs exist (`agent-action-guard`: `UserPolicy`, `ActionApproval`, guarded transfer via CPI). **v1 wires a co-sign path; v2 = the `ActionApproval` PDA endgame.** See [Appendix](#appendix--solana-integration-status-updated-2026-07-02).
- **Audit store — in-memory `Map`** → must become the **durable verdict store + flywheel** (WS2): decision **plus outcome**, keyed by `correlationId`.
- **Judge — the co-sign decision-maker** (separate workstream). Effect-simulation (Blockaid/Blowfish) supplies the structural authority-change/drainer signal.

## What the demo must show

> A real agent in Claude/Cursor attempts an action that **caps would pass but is outside the owner's mandate** → the **judge denies** → **Compass withholds its co-signature** → the transaction **cannot execute** (it's a 2-of-2; the agent's signature alone is invalid). Then the agent **tries to bypass Compass and can't** — it only holds an insufficient key. Backed by real, on-chain **§01 evidence** that this attack class is real.

The **withheld co-signature IS the stop** — non-bypassable, at the signature, not a proxy soft-block. The **bypass-fails beat** is the whole pitch — the thing the old proxy demo could *never* show (in that demo, the agent *can* bypass).

## Workstream 0 — Custody spine (the veto) · NEW, critical path

Goal: on devnet, the agent's funds sit behind a **Compass co-signature**, so the "stop" is real and non-bypassable.

- [ ] **Dedicated allowance account** — a **Squads multisig** (agent + Compass; 2-of-2, or **2-of-3 with a user recovery key**), funded with a **bounded devnet allowance**. NOT the user's main wallet (**gate, not wallet**).
- [ ] **Agent holds an *insufficient* key** — a member key that can propose/sign but **cannot execute alone**.
- [ ] **Compass co-sign service** — agent proposes → Compass evaluates (**tripwire → judge**) → **co-signs or withholds**. Compass's co-sign key lives **server-side** (KMS / Vault, ed25519). *(Non-custodial: it's a **veto** key — never enough to move funds alone.)*
- [ ] **Replace the pure-passthrough proxy with the co-sign gate** — revive the orphaned on-chain layer into the live decision path (see Appendix).
- [ ] **Non-custodial check** — verify Compass **can't spend alone**, and the **recovery path** works (user can reclaim if Compass vanishes → can't freeze).

## Workstream 1 — Plug & play (provision custody at onboarding)

Goal: a stranger onboards into a **Compass-gated account** with a copy-paste block; the smart path works without local LLM config. *(You **provision** the account — you can't retrofit a stop onto a raw-key agent.)*

- [ ] **Onboarding = create the co-sign account** (Squads multisig + issue the agent its insufficient key), funded with a devnet allowance. This is the install. *(Demo: **manual/scripted** setup is fine — no polished one-command install needed; the old MCP-proxy `npx` install is not the thing anymore.)*
- [ ] **Stable hosted endpoint** — production URL + a real key (replace the one-off Vercel preview-hash URL + shared hardcoded key). *(Demo: a **dev endpoint** runs the judge fine — a stable production URL + key is a plug-&-play concern, **post-demo**.)*
- [ ] **Server-side inference wiring** — the judge runs in the hosted backend so the user configures **no LLM locally**; this plan owns the on/off default + the hosted call path.
- [ ] **Approval channel — must-have.** Where `REQUIRE_APPROVAL` surfaces in Claude/Cursor. Doubles as the **false-positive label source** for the flywheel (an approved deny = an instant label). *(Scenario 2: transfer → approve → proceeds is dead without this.)*
- [ ] **One verified copy-paste config block per client**, in the README.

## Workstream 2 — Demo readiness + durable verdict store (the moat)

Goal: the demo runs on real (devnet) transactions through the co-sign gate, reliably, in one client — and every decision is captured for the flywheel.

- [ ] **Wire a real devnet Solana MCP as the downstream** (replace the `scripts/test-downstream-mcp.mjs` mock). Candidate: **Solana Agent Kit** (SAK-as-signer is the clean hook).
- [ ] **Durable verdict store + outcome capture** — persist **decision + full context** (tool, amount, recipient, mandate/intent, risk, reasons, rationale, timestamp, **`correlationId`**) **AND the outcome** (override → false-positive, dispute/rescan → false-negative, silent allow → true-negative), bound back by `correlationId`. *This is the moat:* labeled decisions the observe path can't produce. Storage: SQLite / Postgres / Vercel KV — fastest to ship.
- [ ] **Verify end-to-end in ONE client** with the 3 scenarios (balance→ALLOW, transfer→APPROVAL, **off-mandate→DENY via withheld co-signature**). Fix whatever breaks.
- [ ] **De-flake** the deterministic parts (stable downstream, deterministic scenario inputs).
- [ ] **Delete the stale `docs/wave-8-demo-hardening/runbook.md`** (imports code deleted in wave 11).

## Workstream 3 — Validation evidence

Goal: the "problem is real" section — cheap instruments that **double as demo assets** and fill the validation plan's two open brackets (frequency, $ impact). *(Unchanged by the pivot — still valid.)*

- [ ] **On-chain measurement harness** — count the failure-mode family (authority/approval changes, wrong-recipient, drained delegations) in agent-attributable Solana tx over N months. Output: the "problem proven, on-chain" slide + the *frequency* + *quantifiable impact* numbers. *(Demo: **trim to a small sample** or lean on the §01 incidents; the full multi-month harness is post-demo.)*
- [ ] **§01 case curation** — verify the five incidents (Grok/Bankr ~$175K, JaredFromSubway $7.5M, Lobstar Wilde $450K, malicious LLM routers $500K, Cursor) against sources; keep the dated, dollar-quantified table demo-ready.
- [ ] **GitHub demand harvest** — SAK issues #565 / #575 / #542 / #504 / #88 + independent spend-leash hacks (`onleash`, `@prflght/sak-plugin`, `up2itnow0822/agent-wallet-sdk`): counts, 👍, forks.
- [ ] Interviews are the validation plan's job — **reference, don't duplicate.**

> **Validation-gating:** the demo's headline scenario should follow what the on-chain harness + §01 show is the **real, frequent** failure mode — don't hard-code the ~$0 authority-change if the data says the live pain is wrong-recipient or something else. The three outcomes (Real-now / Real-not-yet / Not-real) still apply.
>
> **ICP note (from the custody research):** the biggest holds-own-key segment is retail traders who chose hot keys for *speed* and may not *want* a veto. Aim the demo/pitch at **owners worried about an agent** — treasuries, §01 drain victims, agents spending *someone else's* money — not speed-maximizing self-traders.

## Workstream 4 — Demo assembly & narrative

Goal: one rehearsed arc, with a fallback if the stage flakes.

- [ ] **The arc:** problem-proven (WS3) → live agent attempts an off-mandate action on a real devnet MCP → **judge denies → Compass withholds its co-signature → tx dies** → **agent tries to bypass, can't** → verdict dataset accumulating (WS2) → the ask.
- [ ] **Decide live vs recorded** (depends on how reliable the co-sign path is by week 3).
- [ ] **Record a fallback** walkthrough regardless.
- [ ] Rehearse end to end.

## The three-zone decision (tripwire → judge)

At the co-sign gate, every gated tx runs through:

1. **Tripwire (~99%, cheap, deterministic):** caps, whitelist, **authority-change / drainer via effect-simulation** — *effect, not payload* (simulate what the tx *does*, don't parse bytes). **Buy this: Blockaid or Blowfish** — commodity + threat-intel, not the moat. Clearly-OK → co-sign; clearly-BAD → withhold.
2. **Judge (LLM, the ambiguous ~1–2%):** intent-vs-mandate reasoning on the cases the tripwire can't settle. **Latency is bounded** — only ~1–2% hit the LLM.
3. **TOCTOU guard:** co-sign the **exact tx simulated** (locks the bytes → payload-swap invalid); tight sim→execute window + on-chain invariant asserts (min-output, expected-owner) for state-TOCTOU (the irreducible residual).

## Liability ceiling (v1) {#liability-ceiling}

The line we do **not** cross: **Compass never holds a key that can move funds on its own.** v1 holds a **co-signing (veto) key** — one of the required signatures, can block, can't spend alone. **No** MPC / custodial relay / TEE-custody in v1 (they make us a custodian → money-transmitter / PCI-AML weight). Ship a **user recovery path** (2-of-3 or timelock) so we can't freeze either. *(v2 PDA removes even the veto key → attestation-only.)*

## Build sequence (now ~2 weeks out — nothing from the old Week 1 is built)

*Today 2026-07-02. The original Week-1 foundations (stable hosted endpoint, devnet MCP downstream, on-chain harness) are **NOT done** — and the pivot changed what's needed, so we re-scope to the veto demo's **critical path**, not the old list.*

**Critical path — the demo doesn't exist without these:**
1. **WS0 — co-sign spine:** a **Squads devnet account** (agent + Compass) + the **Compass co-sign service** + the **judge** deciding whether to co-sign. *The new #1.*
2. **A real devnet tx through the gate** via **SAK-as-signer** (Compass is Solana Agent Kit's signer) — the reframed "downstream."
3. **Judge on a dev endpoint** — not a production hosted endpoint.
4. **§01 curation slide** — the cheap "problem is real" evidence.
5. **A simple durable verdict store** showing decisions accumulating (a basic table is fine — the flywheel narrative).
6. **Demo assembly + the bypass-fails beat.**

**Cut or defer for the demo (do NOT spend the 2 weeks here):**
- **Production hosted endpoint + plug-&-play install polish** — that was the old *MCP-proxy* install; the demo runs on a **dev endpoint** with **manual/scripted** provisioning.
- **Full on-chain measurement harness** — **trim to a small sample** (or lean on the §01 incidents) for the slide; the multi-month harness is post-demo.
- **v2 PDA** — post-demo endgame; don't touch it now.
- **EVM adapter** — Solana-first.

**Rough weeks:**
- **Week 2 (now, Jul 1–7):** WS0 spine + SAK-through-gate + judge-on-dev-endpoint. *(judge workstream lands the intent-aware judge here, gating the co-signature.)*
- **Week 3 (Jul 8–14):** simple verdict store + §01 slide + WS4 demo assembly (**bypass-fails** beat) + rehearsal + recorded fallback.

## Judge handoff contract

The clean interface so the two workstreams compose.

**This plan provides TO the judge workstream:**
- The **verdict-store schema** the judge writes into: `{tool, amount, recipient, mandate/intent, decision, risk, reasons[], human_explanation, timestamp, correlationId}`.
- The **co-sign integration point** — the judge's verdict **gates whether Compass adds its signature** (deny → withhold). Plus the hosted call path + on-by-default flag.
- The **demo scenario** the judge must reliably handle (headline = whatever WS3 validates; default candidate: the ~$0 authority/approval escalation, mapped to Grok/Bankr).

**This plan needs FROM the judge workstream:**
- The judge **on by default, server-side** (plug & play delivers it with no local LLM config).
- A verdict in the **store schema shape** (so the durable store + "dataset accumulating" work).
- Reliable enough for a **live demo** — the withheld-co-signature stop in WS4 depends on it.

## Exit criteria (demo-ready)

- [ ] Onboarding **provisions a Compass co-sign account** (Squads multisig, agent + Compass) on devnet.
- [ ] A real devnet tx through the **co-sign gate**; an **off-mandate action gets its co-signature WITHHELD** → tx cannot execute.
- [ ] **Bypass-fails** demonstrated — the agent can't move funds without Compass (insufficient key).
- [ ] `REQUIRE_APPROVAL` has a working human-approval path (doubles as the false-positive label source).
- [ ] Durable verdict store persisting **decision + outcome**; demo shows it accumulating.
- [ ] **Non-custodial** verified — Compass can't spend alone; recovery path works.
- [ ] §01 incidents verified with sources; on-chain failure-mode count produced.
- [ ] Demo rehearsed; recorded fallback captured.
- [ ] *(judge: on-by-default, intent-aware, reliable — owned by the separate workstream; integration verified against the handoff contract.)*

## Appendix — Solana integration status (updated 2026-07-02)

**The framing flipped: the on-chain co-signer/approval layer is NO LONGER "leave orphaned" — the veto pivot makes it the spine.** The code audit below (from `release/compass_migration`) now reads as *"here's what's already built to wire."* v1 wires a co-sign path (Squads and/or the `ActionApproval` seam); **v2** turns the existing `ActionApproval` PDA into the program-gated, attestation-only endgame.

The two Anchor programs are non-trivial and devnet-deployed (IDs in `docs/onchain-deployments.md`):
- `back/solana/agent-action-guard/` — `UserPolicy`, `ActionApproval`, `WalletSafetyAttestation`, `AttestorConfig`; guarded SOL transfer via CPI; Pyth oracle-gated conditional execution; checked arithmetic + unit tests.
- `back/solana/conditional-escrow-buy/` — full USDC→SOL escrow with oracle price gating, treasury/vault PDAs, cancel/reclaim.

### 1. Approvals on chain — ✅ built; **wire it (this is the v2 PDA seam)**
- `ActionApproval` PDA (seed `["action_approval", user, action_hash]`), created by `create_action_approval`, with `revoke_action_approval` / `mark_executed` / oracle-conditional `mark_executed_if_price_below`.
- TS read/verify layer is real — `hosted/onchain/onchainApproval.ts` (~530 lines) derives the PDA, checks executed/revoked/expired/recipient/amount/user.
- **Gap to close:** no TS *creates* an approval on-chain (that writer was in the deleted `legacy/`), and `AGENT_ACTION_GUARD_PROGRAM_ID` is empty in `.env.example`. **v2 work:** re-introduce the creator + call `verifyTransferGuardReadiness` from the gate before signing.

### 2. Audit of decisions — ❌ off-chain, in-memory → **this is the WS2 durable verdict store + flywheel**
- `hosted/audit/auditStore.ts` = `createInMemoryAuditStore()` (a `Map`, wiped on restart); omits amount/recipient/rationale, and has **no outcome field**. WS2 makes it durable **and** adds the outcome capture (the flywheel).

### 3. Per-user policies — ⚠️ per-user on-chain in the contract; single global policy live
- On-chain `UserPolicy` PDA with caps (`max_transfer_lamports`, `max_swap_usd`, `max_slippage_bps`, …) exists and is enforced by the program.
- Live engine uses one hardcoded `DEFAULT_POLICY` — nothing reads the on-chain `UserPolicy`. **v2 work:** load each user's on-chain `UserPolicy` into the decision instead of the global default (the "caps the user sets survive a Compass compromise" property).

### Status summary

| Concern | On-chain program | v1 (co-sign, demo) | v2 (PDA, post-demo) |
|---|---|---|---|
| Approvals (`ActionApproval`) | ✅ written, devnet | co-sign gate (Squads) | wire the PDA + creator |
| Audit of decisions | ❌ no account | durable store + flywheel (WS2) | (optionally hash-anchored) |
| Per-user policies (`UserPolicy`) | ✅ written | global default OK for demo | load on-chain per-user policy |
