# Reconstruction read surface — ship the replay, stamp the build (plan)

> **Status: approved-for-build 2026-08-05.** Closes the last two gaps between the persisted
> data and the claim "every verdict can be reconstructed from objective/terms, action,
> evidence, rule or model, decision, and version". Follows
> `docs/superpowers/plans/2026-07-26-verdict-reconstruction.md` (D1–D7, D4a, D4b), whose D6
> deliberately scoped the read surface out; this plan picks it up.

## Problem (grounded)

The reconstruction *data* is complete and live-verified (migration rehearsed against a clone of
the real 66-row table 2026-08-05; deterministic re-derivation confirmed on real Postgres). Three
things still separate that from the claim:

| Gap | Where it lives today |
|---|---|
| Reconstruction is a property, not a capability | `replayVerdict` is defined INSIDE `hosted/verdict/verdictReplay.test.ts:62`; grep confirms no other caller, no route, no script. Answering "why was verdict X denied?" requires a repo checkout and vitest. |
| The proof tests a copy | Because the function lives in the test, no shipped implementation exists for it to verify. A future endpoint could diverge and the test would still pass. |
| The engine build is not recorded | Replay re-runs `evaluateAction`, `clampLlmDecision`, `collapseToHostedDecision`, `composeVerdictExplanation`, `mergeJudgeReasons` from the CURRENT build. Verified 2026-08-05: no `appVersion`/`gitSha`/`commitSha` is stamped anywhere. This is the D4a/D4b drift class one layer out — and the one input that CANNOT be snapshotted, because it is code. |

Secondary: replay `throw`s on rows predating the snapshots. Correct for a test, wrong for a
tool — and all 66 production rows are in that category.

## Decisions

- **[R1] Extract `replayVerdict` into `hosted/verdict/verdictReplay.ts`; the test imports it.**
  Single source of truth: the reconstruction proof then tests the SHIPPED function, not a
  private copy. This alone fixes gap 2 and is a precondition for any surface.
- **[R2] Expose it as a LOCAL CLI (`scripts/replay-verdict.ts`), NOT an HTTP route.** Direct
  precedent, same repo, same reasoning: `hosted/app.ts:105-109` records that metrics were
  deliberately un-routed because "the /v1 middleware admits any per-email credential, and
  /signup mints those publicly, so /v1 auth alone would expose every user's email";
  `scripts/metrics-dashboard.ts:1-9` adds "whoever reads this dashboard already has DB access,
  so the endpoint bought nothing." A verdict row is strictly more sensitive than a metrics
  figure — it carries `mandateSnapshot` (the owner's private standing instructions),
  `authenticatedEmail`, `statedPurpose`, recipient and amount.
  *Rejected:* `GET /v1/verdicts/:id` with owner-scoping — it would need a permanent auth gate
  maintained forever, and every consumer who could legitimately call it already has DB access.
- **[R3] Refusal is a VALUE, not an exception.** `replayVerdict` returns
  `{ ok: true, … } | { ok: false, reason }`. A tool must report "this row predates the policy
  snapshot" as data; throwing makes every legacy row an error the caller has to catch. All 66
  live rows take this path, so it is the common case, not the edge.
- **[R4] Stamp the build: `engineVersion` on every verdict.** Code cannot be snapshotted, so
  record WHICH BUILD decided — turning an unanswerable question into a `git checkout`. Source:
  `VERCEL_GIT_COMMIT_SHA` (set by Vercel), else `COMPASS_ENGINE_VERSION`, else absent. Absent
  rather than `"unknown"`: a sentinel that looks like a value is worse than a missing field.
  Replay reports a mismatch between the row's `engineVersion` and the running build as a
  WARNING, not a refusal — the deterministic legs are snapshotted, so replay is usually still
  correct; the operator decides whether to trust it.

## New field (TS ↔ Pg)

| `DecidedInput`/`VerdictRecord` | column |
|---|---|
| `engineVersion?: string` | `engine_version text` |

## Tasks

1. **Extract** — new `hosted/verdict/verdictReplay.ts` exporting `replayVerdict(record)` and the
   `ReplayResult` type (R1, R3). `verdictReplay.test.ts` deletes its local copy and imports it;
   every existing assertion must still pass unchanged, which is the proof the extraction was
   faithful. Refusal tests move from `toThrow` to asserting `{ ok: false, reason }`.
2. **engineVersion** (R4) — `verdictStoreTypes.ts` (both types); `verdictStorePg.ts` (CREATE
   TABLE column + `ADD COLUMN IF NOT EXISTS` migration + INSERT column/param — **re-verify
   column/param/`$N` alignment mechanically after renumbering**); `verifyService.ts` reads it
   from env at the write; contract tests for round-trip + absent-when-omitted.
3. **CLI** — `scripts/replay-verdict.ts` (R2): takes a correlation id, reads the row via the
   real Pg store, replays, prints the reconstruction — what the decider saw (mandate, purpose,
   policy cap, classification), what the rules decided, what the model said, and the final
   decision. Refuses legibly on legacy rows. Header comment states plainly that it is local-only
   and why, mirroring `metrics-dashboard.ts`. Add an `npm run replay` script.
4. **Live jsonb guard** — `engine_version` is `text`, not jsonb, so no new binding risk; confirm
   the guard still passes unchanged rather than assuming it.

## Verification

- `npx vitest --config vitest.back.config.ts --run` — full backend suite green (baseline on
  main: 573 passed | 26 skipped).
- Bite-test each behavioral change by reverting it; a test that cannot fail proves nothing.
- Live, against real Supabase Postgres in a throwaway schema cloned from `public.verdicts`
  (structure + all 66 rows): migration rehearsal, legacy rows still readable, a new verdict
  round-tripped, and the CLI run end to end against a real row.
- **Production `public` is not touched.** Reconstruction columns remain unprovisioned there; the
  next deploy runs the migrations.
- Do not gate on `tsc --noEmit` — known-broken repo-wide by an unrelated bad import.

## Out of scope

- **Judge prompt persistence.** Only the judge's OUTPUT is recorded. Storing prompts carries
  real privacy and volume cost, and "the LLM is a recorded actor, not a replayable function" is
  a defensible position — but it must be stated openly, not implied away. The model leg is
  auditable, not reproducible.
- **HTTP endpoint** (R2) and any hosted read route.
- **Backfilling the 66 legacy rows.** Their decision-time policy, classification, and mandate
  were never recorded and are not recoverable. Replay refuses them by name.
- Raw request arguments — `policyContext` is deliberately typed and bounded (never raw args);
  reconstruction shows what the engine saw, not the literal request.
