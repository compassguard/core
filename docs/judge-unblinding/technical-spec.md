# Judge Un-blinding — technical spec

> Implementation detail for [proposal.md](./proposal.md). Target: `release/compass_migration`.
> Owner: judge workstream (CTO). Reviewers: Fran (impl), Rama (sign-off).

## 1. Current pipeline (verified)

```
route (LLM classifier: transfer|swap|skip|unknown)
  → derivePolicyContext(request.arguments)        // flags = readBoolean(args, ["authority_change"]) ← SELF-REPORT
  → policyEngine.evaluateAction                   // deterministic decision
  → callLlmJudge(rawContext: request.arguments)   // advisory, tighten-only, SAME self-report
  → audit
```
No transaction is ever decoded or simulated.

## 2. Target pipeline v2

```
Phase 0  classify + route                                   (unchanged)
Phase 1  TIER-1 deterministic DENY  (cheap, no sim)         ── DENY ──▶ done (fast, no sim cost)
            • cap vs stated amount (fast-reject heuristic)
            • destination on blocked_recipients
            • destination reputation (Solscan, walletSafetyValidation)
Phase 2  DECODE + SIMULATE the real tx   [budget SIM_BUDGET_MS]
            • reuse connection from hosted/onchain/onchainApproval
            • timeout > budget ── REQUIRE_HUMAN_APPROVAL (SIMULATION_TIMEOUT) ──▶ done (never silent-approve)
            • emits LocalFinding[] from real effects
Phase 3  TIER-2 deterministic DENY  (on ground truth)       ── DENY ──▶ done
            • authority_change / unlimited_delegate / new-authority  (from decode/sim diff)
            • REAL amount vs cap, REAL destination vs allow/denylist
Phase 4  LLM JUDGE on the real action   (owns APPROVE)
            • input = decoded instructions + sim effects + userIntent (mandate), CrabTrap-hardened
            • clamp stays tighten-only as a safety rail
Phase 5  audit                                              (unchanged)
```

**Why simulation sits after Tier-1 (the latency rule):** cheap checks fail-fast on obvious bad, so you only
pay the ~500ms sim round-trip on transactions that would otherwise be *approved* — exactly the set where
ground truth matters. This is both latency- and correctness-optimal.

## 3. Concrete changes (file → change)

### 3.1 NEW — `back/services/solana/txInspection/inspectTransaction.ts`
"Read the real thing." Decode = the CrabTrap-equivalent (render the action legible); simulate = the substrate
upgrade (catch effects the declared instructions hide — CPI/inner ix).

```ts
export type InspectionResult = {
  ok: boolean;            // false when no tx available or RPC error
  timedOut: boolean;      // exceeded SIM_BUDGET_MS
  latencyMs: number;
  decoded: DecodedInstruction[];   // {programId, kind:'transfer'|'setAuthority'|'approve'|'unknown', accounts, args}
  effects?: { lamportDeltas: ...; tokenDeltas: ...; authorityChanges: ... };
  findings: LocalFinding[];        // existing channel — { code, severity, message }
};

export async function inspectTransaction(
  serializedTx: string,            // base64 tx (see §5)
  connection: Connection,          // reuse onchainApproval's connection
  opts: { budgetMs: number },
): Promise<InspectionResult>;
```

### 3.2 CHANGE — `evaluationService.derivePolicyContext`
Derive `flags`, `amount_usd`, `recipient_address` from **`InspectionResult`**, not `readBoolean(args, …)`.
Args remain only a fallback and **must set** `context.flags.__source = "self_report"` so judge/audit know the
decision ran on unverified input (degraded mode).

### 3.3 CHANGE — `evaluationService.buildDecisionResponse`
Reorder into Phases 1–4. Tier-1 = cap/denylist/reputation (cheap). Tier-2 = `evaluateBlockedFlags` + a
re-validation of amount/destination against the **simulated** values (catches an agent that under-reports
`amount_usd` to slip the cap). `policyEngine` itself barely changes — it already consumes `context.flags`; we
change *where the flags come from*.

### 3.4 CHANGE — LLM judge input (`sanitizeLlmJudgeInput` + `callLlmJudge`)
Add `inspected` (decoded instructions + sim effect summary) and `userIntent` (from `agentContext.userIntent` —
**captured today, never passed**). Harden like CrabTrap: JSON-encode every field so request/policy content
can't inject the judge; cap sizes. Keep tighten-only clamp as a safety rail.

### 3.5 Latency / config
- `SIM_BUDGET_MS` (env, default **500**). Per-request hard timeout on Phase 2 via `AbortController`.
- Timeout ⇒ `REQUIRE_HUMAN_APPROVAL`, reason `SIMULATION_TIMEOUT`. **Never** ALLOW a tx you couldn't inspect.
- Record `simLatencyMs`, `timedOut`, `flags.__source` on the existing PostHog `hosted_action_evaluated`
  event — to tune the budget and watch the fallback rate.
- Optional flag `SIM_BEFORE_CHEAP_CHECKS` (default **off**): if telemetry shows p95 sim ≪ budget, you *may*
  move sim ahead of Tier-1 so even the cheap checks run on ground truth.

## 4. The latency rule, precisely

- Simulation **always runs after Tier-1 deterministic checks** — structurally, not conditionally.
- Each simulation is **budgeted at `SIM_BUDGET_MS` (default 500)**; over budget ⇒ fail-closed to human approval.
- "Time it" = the `simLatencyMs` telemetry — tune the budget; decide later whether to enable
  `SIM_BEFORE_CHEAP_CHECKS`. Never block the cheap path on the sim.

## 5. The one real dependency (call out before building)

Simulation needs an actual transaction:
- **Signing tools** (`sign_transaction`, `sign_and_send_transaction`) carry the serialized tx in args. **This
  is the canonical, highest-fidelity inspection point** — land v2 here first.
- **High-level tools** (`transfer_sol`, `orca_swap`) have no serialized tx at the proxy; Compass must **build**
  the candidate tx (the `transferGateway`/`swapGateway` already construct proposals) then inspect. Phase-2b.
- No tx and can't build one ⇒ Phase 2 returns `ok:false` (not timeout) ⇒ fail closed to
  `REQUIRE_HUMAN_APPROVAL`, `flags.__source = "self_report"`. Explicit, not silent.

## 6. Rollout — observe-first

1. Behind `COMPASS_TX_INSPECTION_ENABLED`. **Shadow mode:** run Phases 2–3, **log** the would-be decision +
   findings, keep returning the *current* decision. Compare shadow vs. live for N days.
2. Confirm sim latency distribution, timeout rate, and that the SetAuthority/under-report cases flip to DENY
   in shadow.
3. Flip to **enforce**. The shadow log doubles as demo/validation evidence (how many live-ALLOWED txs the
   shadow path would have flagged).

## 7. Acceptance tests

| Test | Today | v2 expected |
|---|---|---|
| Transfer/sign whose real tx has a `SetAuthority` ix, args omit `authority_change` | ALLOW | **DENY** (Tier-2 from decode/diff) |
| `amount_usd: 5` in args but real tx moves 500 USDC | ALLOW (under cap) | **DENY/approval** (Tier-2 re-validates real amount) |
| Slow sim stub (> `SIM_BUDGET_MS`) | n/a | `REQUIRE_HUMAN_APPROVAL`, reason `SIMULATION_TIMEOUT`, never ALLOW |
| Obvious deny (denylisted dest) | DENY | **DENY without any sim call** (assert `inspectTransaction` not invoked) |
| No-tx tool path | varies | fail-closed `REQUIRE_HUMAN_APPROVAL`, `flags.__source="self_report"` |

## 8. Detection logic — sim output → `LocalFinding[]`

A **pre/post account diff**: fetch state before, simulate, decode the same accounts after, compare. The
mandate violations are *changes to account fields* that no tool argument represents.

```ts
async function inspectTransaction(tx, connection, { budgetMs }): Promise<InspectionResult> {
  const writable = writableAccountKeys(tx);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  try {
    const pre = await connection.getMultipleAccountsInfo(writable);                    // PRE
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true,         // catch CPI
      accounts: { addresses: writable.map(String), encoding: "base64" },               // POST
    });
    clearTimeout(timer);
    if (sim.value.err) return failFinding("SIMULATION_REVERTED", sim);
    const post = sim.value.accounts;
    const findings: LocalFinding[] = [];

    for (let i = 0; i < writable.length; i++) {
      if (isSplTokenAccount(pre[i])) {                                                  // owner == TOKEN_PROGRAM_ID
        const a = AccountLayout.decode(pre[i].data);                                   // @solana/spl-token
        const b = AccountLayout.decode(decode64(post[i].data));
        // ⚠️ token-account DATA `.owner` = user authority, NOT AccountInfo.owner (the program)
        if (!a.owner.equals(b.owner))
          findings.push(block("AUTHORITY_CHANGE", `acct ${writable[i]} authority ${a.owner} → ${b.owner}`));
        if (a.delegateOption === 0 && b.delegateOption === 1) {
          findings.push(block("DELEGATE_GRANTED", `delegate → ${b.delegate}`));
          if (b.delegatedAmount >= b.amount || b.delegatedAmount >= U64_MAX_THRESHOLD)
            findings.push(block("UNLIMITED_DELEGATE", `delegatedAmount ${b.delegatedAmount} ≥ balance`));
        }
        if (a.closeAuthorityOption === 0 && b.closeAuthorityOption === 1)
          findings.push(block("CLOSE_AUTHORITY_CHANGE", `closeAuthority → ${b.closeAuthority}`));
        recordDelta(writable[i], Number(b.amount) - Number(a.amount), b.owner);        // token flow
      } else {
        recordDelta(writable[i], (post[i]?.lamports ?? 0) - (pre[i]?.lamports ?? 0), writable[i]); // SOL
      }
    }
    const { realDest, realAmount } = largestInflow(deltas);                            // independent of args
    if (realDest && !argsDestinations(tx).has(realDest))
      findings.push(warn("NEW_DESTINATION", `real dest ${realDest} not in tool args`));
    if (realAmount != null && argsAmount(tx) != null && !approxEqual(realAmount, argsAmount(tx)))
      findings.push(warn("AMOUNT_MISMATCH", `real ${realAmount} vs args ${argsAmount(tx)}`));

    for (const ix of decodeKnown(tx, sim.value.innerInstructions)) {                   // fast path, known programs
      if (ix.kind === "SetAuthority") findings.push(block("AUTHORITY_CHANGE", `ix ${ix.kind} (decoded)`));
      else if (ix.kind === "Approve") findings.push(block("DELEGATE_GRANTED", `ix ${ix.kind} (decoded)`));
    }
    return { ok: true, timedOut: false, latencyMs: elapsed(),
             decoded: decodeKnown(tx, sim.value.innerInstructions), findings };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, timedOut: ac.signal.aborted, latencyMs: elapsed(), decoded: [], findings: [] };
  }
}
```

### 8.1 SPL token fields that matter (decode via `@solana/spl-token` `AccountLayout`)

| Field | Offset | A change means |
|---|---|---|
| `owner` (user authority) | 32 | **AUTHORITY_CHANGE** — control of the token account transferred |
| `delegate` + `delegateOption` | 72 / 76 | **DELEGATE_GRANTED** — someone can move tokens on your behalf |
| `delegatedAmount` | 121 | with delegate set, `≥ balance` or `≈ u64::MAX` → **UNLIMITED_DELEGATE** |
| `closeAuthority` + option | 129 / 133 | **CLOSE_AUTHORITY_CHANGE** — account can be closed/drained by another |
| `amount` | 64 | real token delta (out = source, in = destination) |

(Native SOL → `AccountInfo.lamports` deltas. **Token-2022** layout differs — gate by program id, decode with
the 2022 layout; unknown layout ⇒ `flags.__source="self_report"`, fail closed.)

### 8.2 Finding → policy mapping
- `AUTHORITY_CHANGE` → `flags.authority_change = true` → `evaluateBlockedFlags` → `policy.blocked.authority_change` (DENY).
- `UNLIMITED_DELEGATE` → `flags.unlimited_delegate = true` (DENY).
- `NEW_DESTINATION` / `AMOUNT_MISMATCH` → not hard flags; passed to the **LLM judge** as the "ambiguous, judge it" evidence.

### 8.3 Reliability caveats (state honestly)
- **Decode** is exact for **known programs** (System, SPL Token, Token-2022, major DEX routers). A custom/
  unknown program can't be statically decoded — that's why the **pre/post diff is the backstop**: it catches
  the *effect* (authority/delegate/balance changed) regardless of which program caused it, including via CPI.
- Request **all** writable accounts the message touches, not a subset — else an attacker hides effects in
  accounts you didn't ask for.
- Catches the cited incident classes (authority change, unlimited delegate, plant-the-payee, under-reported
  amount). Not a proof against a perfectly novel no-state-change attack — but a value-moving attack *must*
  change account state, which is the diff's whole leverage.
