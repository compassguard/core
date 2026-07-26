# Usage metrics — onboarding time + funds secured (GET /v1/metrics)

Status: plan (decision-complete). Branch: `feat/usage-metrics` (worktree off main 008f0e3).

## Goal

Two operator metrics, served by the hosted API and testable live:

1. **Onboarding time** — first user creation → first tx, per user and aggregated.
2. **Funds secured** — USD value screened by the firewall, per day and total.

Both are computed read-only from data already persisted (credentials + verdicts).
No new event tracking, no schema migration on `verdicts`.

## Definitions (frozen — implementation makes no metric-design decisions)

- **User** = distinct normalized email in the `credentials` store. `signupAt` =
  min(`createdAt`) across that email's credentials (revoked ones still mark signup).
- **First tx** has two honest readings, both reported:
  - `firstVerifyAt` = min(`decidedAt`) of verdicts with `authenticatedEmail` = email
    (first guarded action). `secondsToFirstVerify` = (Date.parse(firstVerifyAt) −
    Date.parse(signupAt)) / 1000.
  - `firstConfirmedTxAt` = min(`confirmedAt`) of that email's verdicts where
    `txSignature` is present (first confirmed on-chain tx). Same seconds formula.
- Verdicts authenticated via the shared `COMPASS_HOSTED_API_KEY` carry no
  `authenticatedEmail` and are EXCLUDED from onboarding (no honest join), but
  INCLUDED in funds-secured.
- `decidedAt` can be caller-supplied (`requestedAt`), so a negative duration is
  possible. Per-user rows keep the raw (possibly negative) value; aggregate
  median/average EXCLUDE negative durations.
- **Median**: sort ascending; odd count → middle; even count → mean of the two
  middle values; empty → null. Average: arithmetic mean, empty → null.
- **Funds secured**: over ALL verdicts. `usd` = `intendedEffect.amountUsd ?? 0`.
  Day bucket = `decidedAt.slice(0, 10)` (UTC ISO date prefix; validators enforce
  ISO on the write path). Split by hosted decision: `allowUsd` / `reviewUsd` /
  `denyUsd`; `totalUsd` = their sum. `withAmountUsd` counts verdicts that carried
  an amount, so a large verdict count with tiny USD is legible, not misleading.

## Response contract (frozen)

```ts
// hosted/metrics/metricsContracts.ts
export type OnboardingPerUser = {
	email: string;
	signupAt: string;
	firstVerifyAt?: string;
	secondsToFirstVerify?: number;
	firstConfirmedTxAt?: string;
	secondsToFirstConfirmedTx?: number;
};

export type FundsBucket = {
	verdicts: number;
	withAmountUsd: number;
	totalUsd: number;
	allowUsd: number;
	reviewUsd: number;
	denyUsd: number;
};

export type MetricsResponse = {
	generatedAt: string; // isoNow at compute time
	onboarding: {
		users: number; // distinct signup emails
		activated: number; // users with a firstVerifyAt
		confirmed: number; // users with a firstConfirmedTxAt
		medianSecondsToFirstVerify: number | null;
		averageSecondsToFirstVerify: number | null;
		medianSecondsToFirstConfirmedTx: number | null;
		perUser: OnboardingPerUser[]; // sorted by signupAt ascending
	};
	fundsSecured: {
		totals: FundsBucket;
		byDay: Array<{ day: string } & FundsBucket>; // sorted by day ascending
	};
};

export type MetricsService = {
	computeMetrics(): Promise<MetricsResponse>;
};
```

Route: `GET /v1/metrics` → 200 with `MetricsResponse` as the body (no wrapper
key, no query params). Auth: the existing `/v1` middleware (shared key or any
active credential) — no new auth surface.

## Tasks

### T1 — CredentialStore gains `listIssued()`

The only contract extension. Dependents established by grep (2026-07-26): the
two implementations, the contract suite, and ONE inline fake
(`hosted/http/hostedAuthMiddleware.test.ts` ~line 117 `satisfies CredentialStore`).

- `hosted/credential/credentialStore.ts`: add to `CredentialStore`:
  `listIssued(): Promise<IssuedCredential[]>` with
  `export type IssuedCredential = { email: string; createdAt: string }`.
  In-memory impl: map over `records.values()` (email is already normalized on
  issue). Include revoked credentials — revocation does not erase signup time.
- `hosted/credential/credentialStorePg.ts`: `SELECT email, created_at FROM
  credentials` via `run(...)`, mapped to `{ email, createdAt }`.
- `hosted/credential/credentialStoreContract.ts`: new `it` — issue hash-1 +
  hash-2 for alice, hash-3 for bob, revoke alice; `listIssued()` returns all
  three rows (compare as sets, e.g. sort by tokenless (email, createdAt)).
- `hosted/http/hostedAuthMiddleware.test.ts`: inline fake gains
  `listIssued: async () => []`.

### T2 — metrics service + tests

- `hosted/metrics/metricsService.ts`:
  `createMetricsService(deps: { verdictStore: VerdictStore; credentialStore:
  CredentialStore; isoNow?: () => string }): MetricsService`. Reads
  `verdictStore.list()` + `credentialStore.listIssued()`, computes per the
  frozen definitions in JS (hackathon-scale data; backing-agnostic — same code
  path over in-memory and Pg stores).
- `hosted/metrics/metricsService.test.ts` (in-memory stores, fixed timestamps,
  injected isoNow). Cases:
  1. empty stores → zeros, nulls, empty arrays;
  2. one user, signup 10:00, verdict decided 10:05 with amountUsd 50 allow →
     activated 1, secondsToFirstVerify 300, median/average 300, funds bucket
     correct;
  3. two verdicts for one user → firstVerifyAt is the earlier one;
  4. shared-key verdict (no authenticatedEmail) → counted in fundsSecured,
     absent from onboarding;
  5. negative duration user (decidedAt before signupAt) → perUser keeps the
     negative value, aggregates exclude it (median over the others);
  6. confirmed verdict (closeOutcome with txSignature) → confirmed count +
     secondsToFirstConfirmedTx;
  7. byDay split across two days with allow/deny amounts → buckets + sums;
     verdict without amountUsd → verdicts increments, withAmountUsd does not.

### T3 — route + app wiring

- `hosted/metrics/metricsRoutes.ts`: `createMetricsRoutes(service:
  MetricsService): Hono` with `routes.get("/metrics", async (context) =>
  context.json(await service.computeMetrics(), 200))`.
- `hosted/app.ts`: build `createMetricsService({ verdictStore:
  resolveVerdictStore(), credentialStore })` and mount
  `app.route("/v1", createMetricsRoutes(metricsService))` beside the other /v1
  routes. Comment (constraint, one line): metrics MUST read the same verdict
  store instance as /verify (#15 family) — hence resolveVerdictStore(), and
  construction happens after credentialStore exists.
- `hosted/app.test.ts`: one end-to-end route test using the existing
  `createDependencies()` helper: POST `/signup` → Bearer the returned apiKey →
  POST `/v1/verify` (transfer, `arguments: { recipient, amountUsd: 5,
  recipientKnown: true }`, `intent: { kind: "transfer" }`) → GET `/v1/metrics`
  with the hosted shared key → assert `onboarding.users === 1`, `activated ===
  1`, `secondsToFirstVerify` is a number ≥ 0, `fundsSecured.totals.totalUsd ===
  5`, `allowUsd === 5`. Also: GET `/v1/metrics` without auth → 401.

### T4 — live smoke script

- `scripts/metrics-live.sh` (new, executable): self-contained bash modeled on
  the req/check/resolve_base helpers of the existing verify-live.sh (read it at
  `/Users/lilly/code/solana_hackathon/scripts/verify-live.sh` — it is untracked
  in that checkout, copy the helper functions verbatim). Flow: resolve base URL
  (default `http://localhost:3001`, `BASE_URL` overridable) → POST /signup
  (fresh timestamped email) → POST /v1/verify allow (amountUsd 5,
  recipientKnown true) → POST /v1/verify deny (`mystery_drain`, amountUsd 7) →
  GET /v1/metrics with the minted token → assert: http 200; `onboarding.users
  >= 1`; the signup email appears in `perUser` with a numeric
  `secondsToFirstVerify >= 0`; `fundsSecured.totals.totalUsd >= 12`;
  `totals.allowUsd >= 5`; `totals.denyUsd >= 7`; byDay non-empty. PASS/FAIL
  summary + non-zero exit on failure, same style as verify-live.sh.

## Verification

- `npm test` (vitest.back.config.ts) green in the worktree.
- `npm run lint` green.
- Live: `COMPASS_HOSTED_API_KEY=dev-local-key bun hosted/server.ts` (or
  `npm run hosted:dev`) then `scripts/metrics-live.sh` — run by the dispatcher.

## Non-goals

- No public unauthenticated metrics, no Pg-side aggregation SQL, no changes
  to /verify or /signup behavior, no new env vars.

## Addendum (2026-07-26, stakeholder refinement)

'First tx' is additionally reported as first flagged (review/deny) tx —
`firstFlaggedAt` / `secondsToFirstFlagged` per user, `flagged` /
`medianSecondsToFirstFlagged` / `averageSecondsToFirstFlagged` in the
aggregate. The headline money metric is `possibleFundsLostUsd` =
`reviewUsd + denyUsd` (funds the firewall stopped from moving unchecked),
on every `FundsBucket` (totals and each `byDay` entry). All existing fields
are retained unchanged — this is an additive delta only.

## Addendum 2 (2026-07-26, dashboard — internal-only)

Metrics must be *viewable*, not just fetchable — but the dashboard is an
INTERNAL operator tool, not a page on the public site (operator decision
2026-07-26; an earlier `/metrics` Next.js route was removed in the same
branch). It lives in `scripts/`:

- `scripts/metrics-dashboard.html` — the static page (house visual style,
  plain DOM, no framework/chart library). Asks for an API key (stored in
  localStorage, sent only as the Bearer header), resolves the API base by
  probing `/health`, then renders `GET /v1/metrics`: possible-funds-lost
  hero figure, KPI tiles, a stacked funds-by-day column chart
  (allow/review/deny; validated decision palette — review is `#C08A28`,
  snapped from house bronze for chroma + CVD separation), and the per-user
  onboarding table.
- `scripts/metrics-dashboard.mjs` — local launcher:
  `node scripts/metrics-dashboard.mjs` (env: `BASE_URL` defaults to prod,
  `PORT` to 4400). Serves the page on localhost and proxies ONLY `/health`
  and `/v1/metrics` to the target API — needed because the hosted API sends
  no CORS headers, and the fix must not be adding permissive CORS to a
  public API for an internal tool.
