# Verdict reconstruction — persist the decision-time context (plan)

> **Status: approved-for-build 2026-07-26.** Closes the reconstruction half of "every verdict
> reconstructable": mandate snapshot, statedPurpose, model identity, policy identity, and
> rule-vs-model attribution. Grounded in a full code sweep (two discovery passes over
> `hosted/verdict/`, `hosted/verify/`, `hosted/policy/`, `hosted/llm/`, verified at source).

## Problem (grounded)

Every gap is a value that already exists in-flight at the persistence moment
(`verifyService.ts` `putDecided` call) and is dropped before the write:

| Missing | Where it dies today |
|---|---|
| Mandate snapshot | full `Mandate` fetched for the judge (`verifyService.ts:110-118`), unreferenced at the write; mandate store is a destructive upsert (`mandateStorePg.ts` `ON CONFLICT DO UPDATE`) ⇒ old text unrecoverable |
| `statedPurpose` | local at `verifyService.ts:101`, passed to judge only |
| Model identity | `config.model` trapped in the `createVerifyJudge` closure; `VerifyJudgeResult` has no model field |
| Policy identity | `evaluation.policyId` + `evaluatedRules` returned by `evaluateAction` and never read; `policy.version` in scope at `verifyService.ts:88` |
| Rule-vs-model attribution | `reasons = [...deterministic, ...judge]` merged untagged at `verifyService.ts:136` |
| Judge clamped / confidence | `judged.clamped` never read; `output.confidence` dropped inside `verifyJudge.ts:123-132` |

## Decisions

- **[D1] Mandate snapshot-in-verdict, not a versioned mandate store.** `mandate_snapshot jsonb`
  holding the full `Mandate` object. An audit row records what the decider saw; the mandate
  store's one-row-per-owner contract stays untouched. Rejected: append-only mandate versioning
  (machinery + a join, for no additional reconstruction power).
- **[D2] Snapshot whenever a mandate was found** — including the judge-failure
  (`judge_unavailable`) path: reconstruction must show what the judge *should have* judged
  against. No mandate found ⇒ field absent.
- **[D3] Attribution is additive: persist `judgeReasonCodes` (the judge's contribution)
  alongside the unchanged merged `reasons`.** judgeReasonCodes records the judge's verbatim
  contribution; codes it shares with the deterministic set appear once in the merged reasons
  (deduped at the merge point). The `/v1` response contract does not change. Rejected:
  restructuring `reasons` into tagged objects (breaks the frozen response shape and every
  reader).
- **[D4] Policy identity on every verdict** (`policyId`, `policyVersion`, `evaluatedRules`) —
  every verdict is a policy evaluation, judged or not.
- **[D4a] Policy SNAPSHOT on every verdict** (`policySnapshot`), amending D4 after external
  review (gpt-5.5 via Codex, 2026-07-28). D4 persisted the rulebook's identity but not its
  contents, and `loadDefaultPolicy()` reads a compiled-in constant
  (`hosted/policy/defaultPolicy.ts`) that can be edited without a version bump — so an
  identity check cannot detect drift. Demonstrated: a $5 transfer decided ALLOW replays as
  REQUIRE_HUMAN_APPROVAL after `transfers.max_usd_without_approval` moves 10 → 3 under an
  unchanged `0.1.0`, and `evaluatedRules` silently shrinks from 2 entries to 1. This is D1's
  rule ("an audit row records what the decider saw") applied to the policy; the asymmetry
  with `mandateSnapshot` was an oversight, not a decision. Replay now evaluates against
  `record.policySnapshot` and refuses rows that predate it.
- **[D5] Judge fields only when the judge ran**: `judgeModel`, `judgeClamped`,
  `judgeConfidence`, `judgeReasonCodes` — same presence rule as the existing `judgeRationale`.
- **[D6] Persistence-only slice.** `VerifyActionResponse` unchanged; no new read surface. The
  only consumers of `VerdictRecord` are the confirm service and the stores (verified — no
  `GET /v1/verdicts` route exists yet), so all nine fields are invisible to clients.
- **[D7] No durable audit store.** The demo-day debt registry already schedules folding the
  in-memory audit store into the verdict store when `/v1/evaluate` retires; completing the
  verdict record IS the audit fix.

## New fields (TS ↔ Pg, all optional/nullable)

| `DecidedInput`/`VerdictRecord` | column |
|---|---|
| `statedPurpose?: string` | `stated_purpose text` |
| `mandateSnapshot?: Mandate` | `mandate_snapshot jsonb` |
| `policyId?: string` | `policy_id text` |
| `policyVersion?: string` | `policy_version text` |
| `policySnapshot?: CompassPolicy` | `policy_snapshot jsonb` (D4a) |
| `evaluatedRules?: string[]` | `evaluated_rules jsonb` |
| `judgeModel?: string` | `judge_model text` |
| `judgeClamped?: boolean` | `judge_clamped boolean` |
| `judgeConfidence?: number` | `judge_confidence double precision` |
| `judgeReasonCodes?: string[]` | `judge_reason_codes jsonb` |

## Tasks

1. **Store layer** — `verdictStoreTypes.ts` (nine fields on both types, doc comments);
   `verdictStorePg.ts` (CREATE_TABLE columns + nine `ADD COLUMN IF NOT EXISTS` migrations +
   INSERT columns/params + `rowToRecord` null-guards with `parseJsonb` for the three jsonb
   fields); in-memory store needs no change (spread). Contract tests: full-nine round-trip +
   absent-when-omitted, running against both backings via the existing suites.
2. **Judge surface** — `VerifyJudgeResult` `ran: true` gains `model: string` and
   `confidence: number` (from `deps.config.model` / `output.confidence`); tests assert both
   plus the already-returned `clamped`.
3. **Service wiring** — `verifyService.ts`: hold the loaded policy for `version`; read
   `evaluation.policyId`/`evaluatedRules`; hoist the mandate to a snapshot variable; capture
   `judged.model/clamped/confidence/reasonCodes`; widen `putDecided`. Tests: judged path
   persists all nine; deterministic-only path persists the policy trio + statedPurpose and no
   judge fields; judge-failure path persists the mandate snapshot (D2); response shape
   unchanged.

Verification: `npx vitest --config vitest.back.config.ts --run hosted/` (do not gate on
`tsc --noEmit` — broken repo-wide by a known bad import, debt registry item).

## Out of scope

Read surface (`GET /v1/verdicts` metrics), durable audit store (D7), decode/"full" mode,
mandate versioning, response-contract changes.
