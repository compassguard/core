# Compass — Demo-Day Build Plan (mid-July)

> **Status: re-scoped 2026-07-03 to a `/verify`-endpoint MVP.** Supersedes the "veto/co-sign spine as the demo centerpiece" framing (2026-07-02). That architecture is **unchanged as the long-term enforcement thesis** but is now sequenced **post-MVP**. Grounded in a read of this repo @ `release/compass_migration`.

*Updated **2026-07-03** — the shippable MVP + Demo-Day centerpiece is the `/verify` decision endpoint. ~2 weeks to Demo Day (15–17 Jul).*

> **MVP framing:** the shippable MVP + Demo-Day centerpiece is the **`/verify` decision endpoint** — a **fast, deterministic, stateless, advisory, zero-custody** HTTP API; **every call → the durable verdict store**. The ratified **veto/co-sign spine (Squads v1 → PDA v2)** becomes the **enforcement roadmap** — **same engine + a required key** — explicitly **post-MVP**.

## Why this re-scope (ship the brain, add the teeth later)

The enforcement thesis from the **veto pivot (2026-07-02)** is unchanged: only a **required signer** can actually *stop* a compromised agent — an advisory layer can see but can't block. But co-sign's **onboarding cost** (provisioning a Squads allowance account per user) is the **heaviest, riskiest** part of a 2-week plan.

The **decision engine** — the deterministic tripwire (caps, allowlist, denylist, `authority_change`/`unlimited_delegate`) — is **already REAL** (312 tests). Wrapped behind a **stateless `POST /verify`**, it ships in days, needs **zero custody**, and **any dev (or x402 partner) can call it**. Every call is a **labeled decision → the flywheel/moat**, fed friction-free.

So we **ship the brain (`/verify`) as the MVP + demo**, and keep **co-sign as the enforcement upgrade** (same engine + a required key). `/verify` is **advisory** (bypassable); **co-sign makes `deny` non-bypassable** — that's the roadmap slide, not the MVP.

> **Honest line to hold:** `/verify` alone is **advisory**. For cooperative devs who want a fast safety check they'll honor, that's real, shippable value — and the data firehose is the moat. The **"stop a compromised agent / raw-key bypass"** guarantee needs **co-sign** — kept explicitly on the roadmap so the pitch doesn't overclaim.

## One engine, many adapters (the shape that ties it together)

The same **Decision Engine** (`tx/intent → verdict`) is a plain, transport-agnostic HTTP brain. **The MCP proxy is NOT the engine — it's one *adapter that calls* the engine.** Ports-and-adapters (the same shape used for "the chain layer is a swappable adapter"): build the brain once; how actions *reach* it and how verdicts are *enforced* are pluggable edges.

```
   Claude/Cursor agent               ┌───────────────────────────┐
        │ tools/call                 │   COMPASS DECISION ENGINE  │
        ▼                            │   (deterministic tripwire) │
   [MCP sensor/proxy] ─── HTTP ────► │  POST /verify  → verdict   │
     (adapter #1, agent devs)        │  (phase 2)     → outcome   │──► Verdict Store
                                     │                            │
   x402 partner / backend ─ HTTP ──► │       (same engine)        │
     (adapter #2, raw HTTP)          └───────────────────────────┘
                                                  ▲
   (later) co-sign service ── same engine + a required key ──► enforcement
```

**What flips advisory → enforcing is not the endpoint — it's custody topology (whose signature the money requires):**

| Surface | Depth | Holds a key? | Bypassable? | Onboarding | Status |
|---|---|---|---|---|---|
| **`POST /verify`** | fast deterministic | no | yes (advisory) | zero (`curl` / `mcp add`) | **MVP** |
| **verify phase 2** (outcome) | post-exec read-back | no | — (post-hoc) | zero via sensor | **MVP** |
| **Co-sign gate** | same engine + signature | **yes** | **no** (structural) | provision Squads account | **roadmap** |

**Both MVP adapters, one engine — the distribution play:** ship the **MCP package** (npm — already REAL) for agent-framework devs *and* the **HTTP API + docs** for partners. Coverage differs by adapter:

| | Pre-check (the decision) | Post-check (outcome verify, phase 2) |
|---|---|---|
| **MCP adapter** | ✅ automatic | ✅ **automatic** — the sensor is *in the execution path*, so it sees the tx |
| **Raw HTTP** | ✅ (their call) | ⚠️ **not automatic** — the caller executes on their own infra; a `confirm {correlationId, txSignature}` call opts them in. Fully-automatic = a **chain-watcher, post-MVP** |

The asymmetry is a **visibility boundary**, not a shortcut: to verify an outcome you must *observe* it. **Verification rides the trusted wrapper around the agent, not the agent** — the MCP sensor is a ready-made pre+post wrapper; a raw-HTTP integrator's own backend is their wrapper.

## What the demo must show — the 3-act arc

A produced/recorded promo (record a fallback regardless), on the Solana stack:

- **Act 1 · Install.** `claude mcp add compass` wraps the agent's Solana MCP behind Compass → "policy gate active." *(The MCP sensor is the client that calls `/verify`.)*
- **Act 2 · Enforcement inside a Claude chat.** One legitimate payment passes (**allow**); bad ones **blocked with human-readable reasons** — over-limit / unknown recipient (**deterministic**), off-mandate / authority-change (**deterministic**). After the legit payment executes, **Compass reads the chain back and confirms it did exactly what was intended** (the outcome-verify beat). *(The **prompt-injection catch** = the instruction-provenance leg, and the **raw-key-bypass block** = co-sign — both **roadmap**, shown scripted, labeled "next.")*
- **Act 3 · The Guard Console.** Live counter (allowed / denied / total); **Recent Decisions** audit log rendered from the **verdict store**; **Policy Engine** with editable rules. *"Every action — logged, attributed, auditable. Policies you control."*

> **REAL for the MVP:** Acts 1 & 3, the **deterministic blocks** in Act 2, and the **outcome-verify beat** (MCP path). **Co-sign** ("co-signed it" / raw-key bypass) and **prompt-injection** are the **enforcement/provenance roadmap** — in the promo, scripted, flagged as next.

## Scope

**In (MVP):** the `/verify` endpoint + fast deterministic engine (WS0); durable **verdict store + flywheel** incl. **active outcome capture** (WS1); **dev distribution** via both adapters (WS2); the **policy console**; **validation-evidence** slide (WS3); the **3-act demo** (WS4).

**Roadmap (post-MVP — was the critical path):** the **co-sign spine (Squads v1) → PDA v2** = non-bypassable enforcement; **effect-simulation** (Blockaid/Blowfish) + **LLM judge** = the async **"deep verify"** tier (the [judge-unblinding workstream](../judge-unblinding/proposal.md)); **instruction-provenance** (the prompt-injection catch); the **chain-watcher** for raw-HTTP outcome reconciliation.

**Out:** EVM adapter (Solana-first; chain layer is a swappable adapter); MPC / custodial relay / TEE-custody (liability — see [Liability ceiling](#liability-ceiling)).

## Starting line (current code state)

Grounded in the repo — **hardening + packaging, not building from scratch**:

- **Policy/classification engine — REAL** (caps, allowlists, `authority_change`/`unlimited_delegate` deny flags), 312 tests = **the deterministic engine the `/verify` MVP wraps.** *(Caveat below — flags derive from self-reported args today; the MVP needs the decode half to be honest.)*
- **P1 MCP proxy — REAL**, shipped to npm (`@ramadan04/compass-mcp-guard`), `tools/list` passthrough + `tools/call` interception, 312 tests. **Repositioned as the sensor / `/verify` adapter** — it fires `/verify` pre-call and the outcome check post-call, so agent devs get the full loop from one `mcp add`.
- **Co-signer / on-chain — REAL, now the ROADMAP spine** (devnet Anchor programs: `agent-action-guard` — `UserPolicy`, `ActionApproval`, guarded transfer via CPI). **The MVP does not depend on it;** it's the non-bypassable upgrade. See [Appendix](#appendix--solana-integration-status).
- **Audit store — in-memory `Map`** → becomes the **durable verdict store + flywheel** (WS1): decision **+ context + outcome**, keyed by `correlationId`.

> **⚠️ MVP honesty gap (from the [judge-unblinding workstream](../judge-unblinding/proposal.md)):** today `evaluationService.derivePolicyContext` builds `flags.authority_change` from the agent's **self-reported args**, not the real tx. So a compromised/injected agent that omits the flag passes the deterministic check. For the `/verify` MVP to be honest, it must derive flags from the **decoded tx (ground truth)** — the **decode half** of un-blinding — even though the **simulate + LLM half** is the post-MVP deep-verify tier. Caps and recipient/allowlist checks *can* run on decoded ground truth today; authority-change detection needs the decode step. See [decision tiers](#the-decision-tiers-mvp--tier-1).

## Build status — 2026-07-10 (what's actually shipped)

*From a code read of `hosted/verify/` + the verdict store + vocab (not a runtime test). The `/verify` MVP is largely built; the one substantive gap is the decode module.*

**Shipped & solid:**
- **`POST /v1/verify` + `POST /v1/verify/confirm`** — live routes (`verifyRoutes.ts`) behind API-key auth (`hostedAuthMiddleware` on `/v1/*`). `/verify` is deterministic-only (no LLM inline), server-generates the `correlationId`, and writes a best-effort `DECIDED` record.
- **The confirm state machine** (`verifyConfirmService.ts`) — full and rigorous: `unknown_correlation`; idempotency (`already_closed` → cached outcome); the abuse case (`signature_mismatch` — one correlationId = one execution, can't confirm a *different* tx); a lease for concurrency (`claim`/`release`, covers mid-flight process death); `unconfirmed` (retry); `execution_failed` (on-chain `err` → mismatch); and honest **`unverified_no_decoder`** / fail-closed `error` — never a fabricated verdict.
- **`compareEffects`** — fail-closed per-dimension (recipient / amount / mint); a declared-but-unconfirmable dimension is a discrepancy (never a silent match); every extra instruction is flagged.
- **Durable store** — `verdictStorePg.ts` (Postgres) + env switch (`verdictStoreFromEnv.ts`); in-memory is the fallback. ⚠️ **Verify the deploy selects Pg** — on Vercel serverless the in-memory `Map` is wiped between the `/verify` and `/verify/confirm` invocations, so confirm would return `unknown_correlation` for everything.
- **Decision vocab (4→3) done** — `collapseToHostedDecision`: `ALLOW`/`DENY` map direct, everything else (incl. `REQUIRE_ADDITIONAL_CONTEXT`) → `REVIEW`. No `confirm` decision value → **no collision** with the `/verify/confirm` endpoint. Attribution (`userId`/`sessionId`) validated + stored (not anonymous).

**The one gap — the decode module (pending Fran):**
- `/verify` still decides on the **declared tool call** (`derivePolicyContext(intent.kind, args)`); `verifyService.ts:87–98` explicitly leaves `lamports`/`tokenAmount`/`mint` **undefined, not fabricated**, seamed for "injection ①" (Fran's `decodeTransaction`). The confirm-side `deriveActualEffect` is a stub returning `unverified_no_decoder`. So **today neither side catches a declared-benign-but-malicious tx** — this is the honest **floor**; it becomes the **target** when decode lands. Handoff detail: agree the `arguments` key that carries the serialized tx.

**Still demo-day / unbuilt:** the Guard Console (Act 3), the approval channel, and the seeded-mismatch demo tx.

**Minor:** auth is a single shared hosted key (not per-dev); confirm isn't scoped to the correlationId's *creator* (mitigated by opaque UUID + `signature_mismatch`).

## Workstream 0 — the `/verify` endpoint + fast deterministic engine · MVP, critical path

Goal: the already-REAL engine, behind a stateless HTTP API any dev or x402 partner can call, fast enough to sit inline.

- [ ] **`POST /verify`** — input the **unsigned tx** (+ `mandate/context`) so the intent is decoded ground truth → output `{decision: allow|deny|review, reasons[], human_explanation, correlationId}`.
- [ ] **Deterministic only** — caps, allowlist, denylist, `authority_change`/`unlimited_delegate`; **decode-based** (derive flags from the real instruction, not self-reported args), **no effect-simulation, no LLM** → target **<~100ms**.
- [ ] **Record every call** to the verdict store keyed by `correlationId`, capturing the **intended effect** (so phase 2 has something to compare against).
- [ ] **MCP sensor adapter (no flywheel leak)** — the proxy **routes every `tools/call` verdict through `/verify`**, or if it short-circuits a decision **locally**, **reports it up to the verdict store** — otherwise those decisions leak out of the flywheel/moat. It also **fires `/verify/confirm {correlationId, txSignature}` post-execution**. Raw HTTP stays open for x402 partners / direct integrators.
- [ ] **`POST /verify/confirm` (phase 2 — OPTIONAL)** — the post-execution outcome check (see [design](#phase-2)); **`/verify` deploys and delivers value without it.** Automatic on the MCP path; an opt-in `confirm` call on raw HTTP.

## Workstream 1 — Durable verdict store + flywheel (the moat)

Goal: every decision (and its outcome) captured — the labeled dataset the observe path can't produce.

- [ ] **Durable store** — persist **decision + full context** (tool, amount, recipient, mandate/intent, reasons, human_explanation, timestamp, `correlationId`) **AND outcome**. SQLite / Postgres / Vercel KV — fastest to ship.
- [ ] **Record lifecycle `DECIDED → CONFIRMED_MATCH|MISMATCH`** — `/verify` writes the `DECIDED` record (intended effect); `/verify/confirm` closes it with the outcome (**idempotent**). Active outcome capture **auto-labels false-negatives** (mismatch) instead of waiting for a human dispute; overrides still label false-positives. **No decision leaks** — locally short-circuited proxy decisions get reported up here too.
- [ ] **Metrics surface (MVP — build with the console)** — `GET /v1/verdicts` + a counts endpoint (allowed / denied / review / mismatch) over the verdict store, and a **per-decision telemetry event** on `/verify` (today only exceptions are captured). These are what the console reads; they're also the raw "backend with metrics" a dev can query without the UI.
- [ ] **This is what the console (Act 3) renders** — Recent Decisions + the live counter, backed by the metrics surface above.

## Workstream 2 — Distribution / dev onboarding (both adapters, plug & play)

Goal: a stranger integrates in minutes — **no custody provisioning** (that dropped out with the co-sign deferral).

- [ ] **MCP adapter** — one copy-paste `mcp add compass` snippet per client (Claude / Cursor); wraps their existing Solana MCP; full pre+post loop.
- [ ] **HTTP adapter** — API key + endpoint URL + docs for `POST /verify` (x402 partners / custom backends); pre-check now, optional `confirm` for phase 2.
- [ ] **Approval channel** for `review` / `REQUIRE_APPROVAL` — where it surfaces in the client; doubles as the **false-positive label source**.
- [ ] **Stable dev endpoint** — a dev URL + real key is enough for the MVP (a production hosted URL is post-MVP polish).
- [ ] **Get it in front of ≥1–2 devs** → feedback + real transaction data.

## Workstream 3 — Validation evidence

*(Unchanged by the re-scope — still the "problem is real" section; the demo assets double as validation evidence.)*

- [ ] **§01 case curation** — verify the five incidents (Grok/Bankr ~$175K, JaredFromSubway $7.5M, Lobstar Wilde $450K, malicious LLM routers $500K, Cursor) against sources; keep the dated, dollar-quantified table demo-ready.
- [ ] **On-chain measurement harness** — count the failure-mode family (authority/approval changes, wrong-recipient, drained delegations) in agent-attributable Solana tx. *(Demo: **trim to a small sample** or lean on §01; the multi-month harness is post-demo.)*
- [ ] **GitHub demand harvest** — SAK issues #565 / #575 / #542 / #504 / #88 + independent spend-leash hacks (`onleash`, `@prflght/sak-plugin`, `up2itnow0822/agent-wallet-sdk`): counts, 👍, forks.
- [ ] Interviews are the validation plan's job — **reference, don't duplicate.**

> **Validation-gating + ICP:** aim the demo/pitch at **owners worried about an agent** — treasuries, §01 drain victims, agents spending *someone else's* money — not speed-maximizing self-traders. Let the on-chain harness + §01 pick the **headline failure mode**; don't hard-code the ~$0 authority-change if the data says wrong-recipient is the live pain.

## Workstream 4 — Demo assembly & narrative (the 3-act promo)

- [ ] **The arc:** problem-proven (WS3) → **Act 1 install** → **Act 2 enforcement in a Claude chat** (deterministic blocks + the outcome-verify beat; co-sign + injection scripted as "next") → **Act 3 Guard Console + Policy Engine** (verdict store accumulating) → the ask.
- [ ] **Produced/recorded promo** in the style of the 3-act reference; **record a fallback** regardless.
- [ ] Rehearse end to end.

## The post-execution verification step — `verify → execute → confirm` (optional) {#phase-2}

Closes the loop: confirm the tx that **executed** matches the intent that was **approved** — catching side effects and post-approval divergence. It's **phase 2 of the `/verify` flow, tied by `correlationId`**, driven by the **trusted control plane** (the MCP sensor automatically, or a raw-HTTP dev's own backend) — *never the agent*, so the "it didn't notice" gap can't reopen.

> **`/verify` deploys on its own — this phase is OPTIONAL.** A dev gets full value from just `POST /verify` (decision in → verdict out) and ships in minutes. `/verify/confirm` is an **opt-in** second step for teams who want the closed outcome-loop + richer flywheel data; it never blocks the quick-deploy path.

**The flow (raw-HTTP shape; the MCP sensor drives the same two calls automatically):**
1. **`POST /verify`** — send the **unsigned tx** (so the decided-on intent is decoded ground truth, not self-reported args). Server decodes + decides, **stores the intended effect** keyed by a **server-generated `correlationId`**, returns `{decision, reasons[], human_explanation, correlationId}`.
2. **Dev executes** — signs + submits, gets a `txSignature`.
3. **`POST /verify/confirm {correlationId, txSignature}`** — server loads the intent by `correlationId`, calls `getTransaction(sig)`, derives the **actual effect** (recipient, amount via pre/post balances, and **any instruction not in the intended set**), compares → `{outcome: match | mismatch, discrepancies[]}`, and **writes the outcome to the verdict store**.

**State** — `/verify` gains one record; the store's existing `outcome` field closes it. `confirm` is **idempotent** (repeat → cached outcome, no double-count in the flywheel):

```
DECIDED (stores intended effect)  ──confirm──►  CONFIRMED_MATCH | CONFIRMED_MISMATCH
                                  └─ no confirm within TTL ─►  PENDING / EXPIRED
```

**Confirmation timing (decide):** simplest for devs — `confirm` **waits** (bounded, ~10s) for the tx to confirm, then returns the outcome; on timeout → `{outcome: "unconfirmed"}` to retry. (Alternative: return `{outcome: "pending", retryAfter}` immediately and let them poll.)

**Same endpoint, two drivers:** the **MCP sensor** calls `/verify` + `/verify/confirm` automatically (unskippable); a **raw-HTTP** dev's backend calls both (opt-in — no-confirm records stay `PENDING`; a post-MVP **chain-watcher** reconciles them without a confirm call). Neither relies on the (possibly-injected) agent to call it.

**What it catches:** execution ≠ approval — side effects, an extra `SetAuthority`/`approve`, a diverged recipient/amount. **Not** an injection baked into the approved intent (that's the provenance leg). It **detects, can't undo** — value is the labeled false-negative for the flywheel, blocking the *next* step once co-sign exists, and alerting.

**Enforcement-tier (post-MVP, with co-sign):** mismatch → **withhold the agent's NEXT co-signature / revoke the allowance.** Detect becomes **contain**.

> **Note:** the Verdict Store is the **ledger, not the checker** — it *records* the outcome; this step *produces* it. Prevention stays at the gate; this is detect-and-contain.

## What each layer catches (so the pitch stays honest)

Defense-in-depth, each layer a different class — don't let one layer over-claim another's job:

| Layer | Catches | Status |
|---|---|---|
| **Deterministic `/verify`** | policy violations — over-cap, unknown recipient, `authority_change`/`unlimited_delegate` (from **decoded** ground truth) | **MVP** |
| **Outcome verify (phase 2)** | **execution ≠ approval** — unexpected side effects, an extra instruction, a recipient/amount that diverged after approval | **MVP** |
| **Instruction-provenance** | injection *at the source* — a bad-but-policy-compliant intent whose recipient traces to untrusted input | roadmap |
| **TOCTOU guard** | a **payload swap between approval and signing** (executed bytes ≠ approved bytes) | roadmap (co-sign tier) |

> The outcome check catches side effects and post-approval divergence — **not** an injection that corrupts the intent *before* `/verify` sees it (then "intended" and "actual" both equal the poison → reads as match). Catching that is the **provenance leg**. Say "catches side effects / post-approval divergence," not "catches prompt injection," until provenance lands.

## The decision tiers (MVP = tier 1)

1. **Fast deterministic — the `/verify` MVP:** caps / allowlist / denylist / authority-change, **decode-based (ground truth, not self-reported args)**, `<~100ms`.
2. **Deep verify — roadmap, async:** **effect-simulation** (Blockaid/Blowfish — commodity, buy it) + **LLM judge** on the ambiguous ~1–2% (intent-vs-mandate). Latency-tolerant because it's off the synchronous path. Owned by the [judge-unblinding workstream](../judge-unblinding/proposal.md).
3. **TOCTOU / outcome:** at co-sign, **bind the exact simulated tx** (locks bytes → payload-swap invalid); post-exec, the **phase-2 outcome** read-back.

### Judge / deep-verify handoff contract {#judge-handoff-contract}

The [judge-unblinding workstream](../judge-unblinding/proposal.md) owns tier 2 (LLM judge + effect-sim), now **post-MVP**. Two halves, re-timed by this re-scope:

- **Decode half → needed by the MVP.** Deriving policy `flags` from the **decoded/ground-truth tx** (not self-reported args) is what makes the deterministic `/verify` honest. Land the decode step now; it is not LLM-dependent.
- **Simulate + LLM half → post-MVP deep-verify tier.** The `REQUIRE_SIMULATION` + LLM-on-real-action path (the demo's old "mandate-stop" moment) moves to the roadmap; it is no longer mid-July-critical.

Shared contract stays the **verdict-store schema** `{tool, amount, recipient, mandate/intent, decision, risk, reasons[], human_explanation, timestamp, correlationId}` — the MVP's deterministic `/verify` writes it now; the judge writes the same shape when the deep tier lands.

## Enforcement roadmap (post-MVP) — the co-sign spine

The non-bypassable upgrade: **same engine + a required key.** The MVP is its brain, so this is wiring, not a rebuild.

- **v1 — co-sign (Squads):** funds in a **dedicated allowance account** (agent + Compass, 2-of-2 or 2-of-3 with a user recovery key; **gate, not wallet**); agent holds an **insufficient key**; Compass **co-signs or withholds** based on the same engine's verdict. Non-custodial: a **veto key, never a spend key.** This is where `deny` becomes non-bypassable and the **raw-key-bypass-fails** beat becomes real.
- **v2 — program-gated PDA:** the `ActionApproval` PDA endgame — Compass holds **no fund-moving key**, only an attestation; on-chain caps survive a Compass compromise.
- **Also lands here:** the **deep-verify tier** (judge), **instruction-provenance** (the prompt-injection catch), the **enforcement-tier outcome check** (mismatch → withhold the next co-signature), and the **chain-watcher** for raw-HTTP outcome reconciliation.

## Post-demo hardening & consolidation (architecture debt registry)

The `/verify` build (branch `feat/verify-endpoint`) deliberately shipped **transitional architecture**: two parallel evaluation tracks, two decision stores, an in-memory verdict store, and injected stubs at the decode seam. Each defer was the right call for demo speed — this registry exists so the transition state is **scheduled for demolition, not shipped by default**. Tiered by what it blocks.

### Tier 1 — before real devs integrate (blocks the dev-onboarding milestone)

- [ ] **Durable verdict store** (WS1 swap) — the in-memory `Map` doesn't survive Vercel invocations; hosted confirm, metrics, console, and flywheel are all gated on this. `VerdictStore` interface is swap-ready (one new impl file: KV/Postgres).
- [ ] **Decode integration, both ends** *(pre-demo if the decode module lands in time — WS0 ambition; this registry entry is the fallback slot per the exit-criteria decode-slip rule)* — swap the confirm-side stub for the real `deriveActualEffect` (one line), AND add the `tx` input to `/verify` so flags + **native intended amounts** come from decoded ground truth. Until the second half lands, the amount-compare dimension of confirm is inert and flags are self-reported. Then decide: keep `derivePolicyContext` as an explicit args-only fallback, or retire it.
- [ ] **API versioning discipline** — write the policy (additive-only within `/v1`: new fields/enum values OK, renames/removals ⇒ `/v2`) + a response-shape contract test in CI. The `confirm→review` rename was a breaking `/v1` change that nothing flagged; adopt the rule **before** the first external consumer exists.
- [ ] **Auth + rate limiting** — per-dev API keys with rotation (today: one shared static key), and per-key rate limits on `/verify/confirm` (it holds a handler ~8s while polling RPC — an unmetered cost/DoS vector).
- [ ] **Metrics surface** — *moved into WS1 as MVP work (built with the console); this entry stays only as the checkbox backstop if the console is cut from the demo* — `GET /v1/verdicts` + counts route and the per-decision telemetry event on `/verify`.

### Tier 2 — debt demolition (each ≤1 day; the "clean architecture" pass)

- [ ] **Retire `/v1/evaluate` + consolidate stores** — after the MCP proxy switches to `/verify`, the old LLM-inline track has zero consumers: delete the route + `evaluationService` orchestration, fold the audit store into the verdict store (one decision-history source). The LLM router/judge adapters are **repurposed, not deleted** — they become the async deep-verify tier per the [judge-unblinding workstream](../judge-unblinding/proposal.md) (judge reads `review` records from the verdict store, writes back the same schema).
- [ ] **Resource-scoped confirm route** — when the MCP proxy switches to `/verify`, also reshape the flat `POST /v1/verify/confirm {correlationId, txSignature}` to the resource-scoped `POST /v1/verify/:correlationId/confirm {txSignature}` — it makes the coupling + auth ("you're confirming *this* decision") explicit. Breaking `/v1` path change, so per the API-versioning rule above it must land **before the first external consumer** (or bump `/v2`); do it in the same breaking-change window as the proxy switch so no caller code accretes against the flat shape.
- [ ] **Post-lease-removal schema cleanup** — after the lease removal (workstream A) is fully deployed out AND rollback to a lease-bearing version is impossible: (1) `DROP COLUMN claimed_at` from the `verdicts` table. New code keeps the column **provisioned** (in both `CREATE_TABLE` and the idempotent MIGRATIONS) but never writes it — dropping it now, or provisioning it new-code-first without the column, would error old instances still running the claim/release `UPDATE … SET claimed_at`; the DROP is safe only once no lease-bearing code can run. **Rollback is a concurrency hazard, not just a schema one:** provisioning `claimed_at` keeps old-instance writes from erroring, but leaseless code still ignores an *active* lease — it treats a `CONFIRMING` row as open and closes it out from under an old lease-bearing instance. The atomic first-writer-wins close means this never yields a wrong verdict, only a duplicate fetch+close race, but a rollback to a lease-bearing version **must therefore be non-overlapping** (drain the leaseless instances first, or use a deploy barrier) so the two versions never serve concurrently. The alternative — teaching leaseless code to temporarily respect a fresh lease (re-adding a clock/TTL and a retryable outcome) — was rejected as resurrecting the deleted machinery for a window where correctness already holds. (2) The durable store's `ensureSchema` re-runs the idempotent forward-compat MIGRATIONS (`ADD COLUMN IF NOT EXISTS`) on **every** cold start — gate behind a schema-version check to run once (harmless as-is, just wasteful).
- [ ] **Record-lifecycle TTL / EXPIRED sweeper** — never-confirmed records stay `DECIDED` forever by design; harmless in memory, **unbounded growth once the store is durable**. Ship with/right after the WS1 swap.
- [ ] **Module boundaries** — move the outcome-domain files (`compareEffects`, `deriveActualEffect*`, `getConfirmedTx`, `verifyConfirmService`) from `hosted/verify/` into `hosted/verdict/` so the dirs carve at the joint; stop adding runtime functions to `shared/types/` (give shared logic a non-"types" home).
- [ ] **Proxy hardening** — replace the `"review"` string literal in `mcpProxyDispatcher` with the `HOSTED_DECISIONS.REVIEW` constant (next vocab change becomes a compile error, not a grep hunt); version-bump + republish choreography documented (old published client fails **closed** on unknown decision values — deploy + republish same day). Retiring the #3 legacy `confirm→review` dual-accept in `mcpHostedClientContracts` (once every deployed hosted server returns `"review"`) also removes the last verdict-value `"confirm"`, clearing the collision between the mapped decision value `"confirm"` and the `/verify/confirm` endpoint verb — don't let a verdict value and an endpoint share the word.
- [ ] **Fix the `tsc` gate + CI** — a pre-existing bad import (`mcpProxyDispatcher.test.ts` → `../mcp/mcpProxyContracts`) breaks `tsc --noEmit` repo-wide, so typecheck can't gate anything; fix it, then gate CI on typecheck + vitest + the contract snapshot.
- [ ] **Honest `/health`** — dependency statuses are hardcoded strings (`llm: "ok"` checks nothing); report real checks (verdict store, RPC reachability) and drop the `llm` dep when `/evaluate` retires.

### Tier 3 — architectural, later

- [ ] **Per-user policies** — engine evaluates everyone against the hardcoded `DEFAULT_POLICY`; the policy route is GET-only. Console's editable policy needs the write path; multi-tenant needs per-key policy (then the on-chain `UserPolicy` load, per the appendix).
- [ ] **Chain-watcher** — closes `PENDING` records for raw-HTTP callers without an explicit confirm call (completes the flywheel for non-MCP integrators).
- [ ] **Composition root** — `HostedAppDependencies` is at seven hand-rolled optional overrides; adopt a builder when the console/judge services join.

## Liability ceiling {#liability-ceiling}

The line we do **not** cross: **Compass never holds a key that can move funds on its own.** The `/verify` MVP holds **no key at all** (advisory). The roadmap co-sign holds a **veto key** (one required signature — can block, can't spend alone). **No** MPC / custodial relay / TEE-custody (→ money-transmitter / PCI-AML weight). Ship a **user recovery path** (2-of-3 or timelock) so we can't freeze either. *(v2 PDA removes even the veto key → attestation-only.)*

## Build sequence (~2 weeks out)

**Week 2 (now, Jul 1–7):** WS0 `/verify` + fast deterministic engine (incl. the decode step) + WS1 durable verdict store + MCP-sensor adapter + phase-2 outcome verify.
**Week 3 (Jul 8–14):** the **policy console** (Act 3) + §01 slide (WS3) + WS4 3-act demo assembly + rehearsal + recorded fallback + **get it in front of ≥1–2 devs.**
**Roadmap (post-demo):** co-sign spine (Squads v1 → PDA v2), the deep-verify tier, the provenance leg, the chain-watcher — **plus the [post-demo hardening & consolidation registry](#post-demo-hardening--consolidation-architecture-debt-registry)** (retire `/v1/evaluate`, store consolidation, versioning discipline, per-dev keys, TTL sweeper).

## Exit criteria (MVP demo-ready)

- [ ] **`POST /verify` live** — fast deterministic verdicts on the 3 scenarios (**balance → allow**, **transfer → review/approve**, **off-mandate/over-cap/authority-change → deny**) with human-readable reasons, flags derived from decoded ground truth. **Decode-slip fallback (decided in advance, not at rehearsal):** if the decode module isn't demo-ready, this criterion relaxes to **args-based advisory** — the endpoint ships as-is (already live-tested), the pitch says "flags are caller-supplied in the MVP; decoded ground truth is landing," and decode moves to the hardening registry's Tier 1. Decode slipping does **not** block the demo.
- [ ] **Both adapters work** — `mcp add compass` (full pre+post loop) *and* a raw `POST /verify` call (pre-check).
- [ ] **Phase-2 outcome verify** confirms a legit tx matched intent, and **catches one seeded mismatch** (MCP path).
- [ ] **Durable verdict store** persisting decision + context + outcome; the **console renders** it accumulating.
- [ ] **`review`/`REQUIRE_APPROVAL`** has a working human-approval path (false-positive label source).
- [ ] **≥1–2 devs** calling it (data).
- [ ] §01 incidents verified with sources; small on-chain failure-mode sample produced.
- [ ] 3-act demo rehearsed; recorded fallback captured.
- [ ] *(roadmap, NOT MVP exit: co-sign non-bypassable stop; raw-key-bypass-fails beat; instruction-provenance injection catch; LLM deep-verify tier.)*

## Appendix — Solana integration status {#appendix--solana-integration-status}

*(The on-chain co-signer/approval layer is the **roadmap spine**, not MVP — the audit below reads as "here's what's already built to wire when co-sign lands.")*

The two Anchor programs are devnet-deployed (IDs in `docs/onchain-deployments.md`):
- `back/solana/agent-action-guard/` — `UserPolicy`, `ActionApproval`, `WalletSafetyAttestation`, `AttestorConfig`; guarded SOL transfer via CPI; Pyth oracle-gated conditional execution; checked arithmetic + unit tests.
- `back/solana/conditional-escrow-buy/` — full USDC→SOL escrow with oracle price gating, treasury/vault PDAs, cancel/reclaim.

**1. Approvals on chain — ✅ built; wire it (the v2 PDA seam).** `ActionApproval` PDA (seed `["action_approval", user, action_hash]`), created by `create_action_approval`, with `revoke_action_approval` / `mark_executed` / oracle-conditional `mark_executed_if_price_below`. TS read/verify layer real — `hosted/onchain/onchainApproval.ts` (~530 lines) derives the PDA, checks executed/revoked/expired/recipient/amount/user. **Gap:** no TS *creates* an approval on-chain (writer was in the deleted `legacy/`); `AGENT_ACTION_GUARD_PROGRAM_ID` empty in `.env.example`. **Roadmap work:** re-introduce the creator + call `verifyTransferGuardReadiness` from the gate before signing.

**2. Audit of decisions — ❌ off-chain, in-memory → the WS1 durable verdict store + flywheel.** `hosted/audit/auditStore.ts` = `createInMemoryAuditStore()` (a `Map`, wiped on restart); omits amount/recipient/rationale, no outcome field. WS1 makes it durable **and** adds outcome capture (phase 2).

**3. Per-user policies — ⚠️ per-user on-chain in the contract; single global policy live.** On-chain `UserPolicy` PDA with caps (`max_transfer_lamports`, `max_swap_usd`, `max_slippage_bps`, …) exists + is enforced by the program; the live engine uses one hardcoded `DEFAULT_POLICY`. **Roadmap work:** load each user's on-chain `UserPolicy` (the "caps survive a Compass compromise" property). *(For the `/verify` MVP, the global default is fine — the policy console edits it.)*

### Status summary

| Concern | On-chain program | MVP (`/verify`) | Roadmap (co-sign / PDA) |
|---|---|---|---|
| Decision engine | n/a | ✅ `/verify` wraps the deterministic engine | same engine gates the co-signature |
| Approvals (`ActionApproval`) | ✅ written, devnet | not used | co-sign gate (Squads) → wire the PDA + creator |
| Audit of decisions | ❌ no account | durable verdict store + flywheel (WS1) | (optionally hash-anchored) |
| Per-user policies (`UserPolicy`) | ✅ written | global default OK (policy console edits it) | load on-chain per-user policy |
