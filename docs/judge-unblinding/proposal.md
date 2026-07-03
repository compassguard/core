# Judge Un-blinding — feed the judge the real transaction (proposal)

> **Status: DRAFT / proposal — RE-TIMED 2026-07-03** by the [demo-day plan](../compass-demo-day/proposal.md)
> re-scope to the `/verify`-endpoint MVP. This workstream now **splits in two**: the **decode half** (derive
> policy flags from the real tx, not self-reported args) is **needed by the MVP to be honest** and lands now;
> the **simulate + LLM half** (the old "mandate-stop" moment) is the **post-MVP deep-verify tier** — no longer
> mid-July-critical. Updated 2026-06-24 (re-timed 2026-07-03), grounded in a read of this repo
> @ `release/compass_migration`. Meets the demo-day plan at the
> [Judge handoff contract](../compass-demo-day/proposal.md#judge-handoff-contract).
> Technical detail → [technical-spec.md](./technical-spec.md).

## TL;DR

Today the judge (deterministic policy + advisory LLM) decides on the agent's **self-reported arguments**,
not the real transaction. So a within-cap action that's outside the owner's mandate — the demo's headline
(**~$0 authority/approval escalation, Grok/Bankr**) — can't actually be caught. This workstream **un-blinds
the judge**: decode + simulate the real tx and judge on ground truth. Its **decode half** (ground-truth flags)
is what the re-scoped **`/verify` MVP** needs to be honest; its **simulate + LLM half** is the post-MVP
deep-verify tier (see status above).

## The problem (grounded in code)

- `evaluationService.derivePolicyContext` builds `context.flags.authority_change` via
  `readBoolean(args, ["authority_change"])` — **the agent's own claim**.
- `policyEngine.evaluateBlockedFlags` then trusts those flags.
- The LLM judge gets `rawContext: request.arguments` — **the same self-report**, plus the policy verdict.
- **0** `simulateTransaction` calls in the repo; `REQUIRE_SIMULATION` currently just fails closed.

⇒ A compromised/injected agent that doesn't self-incriminate (`authority_change` omitted) passes **every**
layer. *"The mandate, not the amount"* is sold but not yet implemented — the danger lives in the transaction,
which nothing currently reads.

## Two principles this encodes

1. **Deny vs. approve asymmetry** — deterministic rules are sound for *blocking* but not *complete*, so a
   deterministic **deny is final**; a deterministic **pass escalates** to the LLM. *(Rama's criterion.)*
2. **Input fidelity** — that escalation is only worth anything if the judge sees the **real decoded/simulated
   tx**. The asymmetry *requires* it: if the LLM owns every approval, the approve-path is only as good as what
   the LLM can see. Self-reported args ⇒ rubber-stamp by a blind judge.

## Scope

**In scope:** transaction decode + simulate as a guard step; derive policy `flags` from ground truth (not
args); feed the judge the decoded/simulated action **and** `userIntent` (the mandate, captured today but never
passed); latency budget + fail-closed; observe-first rollout.

**Out of scope (demo-day plan owns it):** plug & play install, approval UI, durable verdict store, demo
assembly. We connect only at the [handoff contract](../compass-demo-day/proposal.md#judge-handoff-contract).

## Why it beats CrabTrap

CrabTrap (Brex, MIT) is **LLM-on-real-action only**. This is **deterministic deny (cheap, fast,
injection-proof) in front of LLM-on-real-action**. Same ground-truth judging CrabTrap has, *plus* a fail-fast
deterministic layer they lack — once the judge sees the real tx. The decode/simulate step is what makes our
hybrid strictly stronger than CrabTrap, not weaker.

## Relationship to the demo-day plan (re-scoped 2026-07-03)

The demo-day plan is now the **`/verify`-endpoint MVP** (deterministic-only), so the old headline — *"an
action caps would pass but is outside the owner's mandate gets stopped by the LLM"* — is a **scripted roadmap
beat**, not the MVP demo. What the re-scope pulls **forward** from this workstream is the **decode half**: the
MVP's deterministic checks (caps, recipient, `authority_change`) must derive from the **decoded/ground-truth
tx**, not self-reported args — otherwise a compromised agent that omits the flag passes, and the demo's
"blocked" beat collapses under one question ("a real attacker just wouldn't set the flag"). The **simulate +
LLM half** stays here as the **post-MVP deep-verify tier**. The handoff contract still pins the interface; the
*timing* now splits — **decode-now, simulate/LLM-later**.
