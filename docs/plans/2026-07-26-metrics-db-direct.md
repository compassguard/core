# Metrics dashboard, DB-direct — delete `GET /v1/metrics`

Status: plan (decision-complete). Branch to cut: `feat/metrics-db-direct` off `main`
(`596eac3`). Supersedes the transport decision in
`docs/plans/2026-07-26-usage-metrics.md` (T3 route + Addendum 3 auth gate).

## Why

The metrics dashboard is an operator tool. Serving it through a public,
internet-facing endpoint means the endpoint must be defended forever — and the
defence has already been subtly wrong once: the operator gate needs TWO checks,
and the identity check alone fell open when no shared key was configured (measured:
200 before the second check was added, `hosted/metrics/metricsRoutes.ts`).

The operator already has Supabase access (operator, 2026-07-26), so the API key
buys nothing they do not already hold. Computing locally removes the entire
internet-facing surface: no route, no auth, no PII-in-transit. Code that does not
exist cannot fail open.

**Precondition — this plan is only correct while that holds.** If a future consumer
needs metrics over HTTP without DB access (a status page, a mobile client, a
non-engineer stakeholder), the endpoint comes back and this plan is void. Verify the
precondition still holds before executing.

## What does NOT change

`createMetricsService`, `metricsContracts.ts`, `metricsService.test.ts`, and the
whole `scripts/metrics-dashboard.html` page are untouched. The service takes STORES,
not a connection (`createMetricsService({ verdictStore, credentialStore })`), and the
page fetches a relative `/v1/metrics` off a `/health`-probed base. Point the base at
localhost and the identical page renders identical numbers. This is a transport
change only.

## Decisions (frozen — the executor makes none of these)

- **The launcher computes; nothing proxies.** `scripts/metrics-dashboard.mjs` keeps
  serving the page and keeps answering `GET /health` and `GET /v1/metrics` on
  localhost, but answers them from `createMetricsService` over Pg stores instead of
  forwarding upstream. The page's own paths stay identical, so the HTML needs no edit
  beyond the key-gate copy (T4).
- **`.mjs` → `.ts`, run via `tsx`.** The launcher must import `hosted/` TypeScript
  (`createPgVerdictStore`, `createMetricsService`). Rename to
  `scripts/metrics-dashboard.ts`; run with `node_modules/.bin/tsx`. Rejected:
  compiling to JS first (adds a build step to a dev tool), and duplicating the
  metrics SQL in JS (a second implementation that would drift from the tested one).
- **Credential: `COMPASS_VERDICT_DB_URL`,** the same var the hosted app uses — same
  Supabase transaction-pooler URL, same `createSqlExecutorFromEnv`. No new env var.
  Absent/blank ⇒ exit non-zero with the message in T2, never a silent in-memory
  fallback that would render an empty dashboard as if it were real (the failure this
  plan most needs to avoid: zeros that look like data).
- **No API key anywhere.** The page's key gate is removed (T4). The DB URL is the
  only credential and it never reaches the browser — it stays in the Node process.
- **`GET /v1/metrics` is deleted, not deprecated.** A gated-but-present route is a
  surface someone must keep correct; leaving it "just in case" preserves exactly the
  risk this plan exists to remove.

## Tasks

### T1 — delete the HTTP route and its wiring

- Delete `hosted/metrics/metricsRoutes.ts`.
- `hosted/app.ts`: drop the `createMetricsRoutes` import, the `metricsService`
  construction, the `app.route("/v1", createMetricsRoutes(...))` line, and the
  now-unused `createMetricsService` import.
- `hosted/app.ts`: **KEEP** the extended `#15` guard (the
  `deps.verifications !== undefined && deps.verdictStore === undefined` throw) but
  reword its comment — the split-brain risk it prevents was metrics-specific, and
  with metrics gone the guard is a general consistency check on injected verify
  services. Do NOT delete it; it is cheap and correct on its own terms.
- `hosted/app.test.ts`: delete the five metrics route tests (the end-to-end one at
  ~line 467, the 401 case, both 403 cases, the operator-key case). Keep the
  verdictStore-injection guard test.

### T2 — the launcher computes metrics locally

Rename `scripts/metrics-dashboard.mjs` → `scripts/metrics-dashboard.ts`, keeping the
existing HTTP server, the `PORT`/`METRICS_HTML` env knobs, and the `/` + `/metrics`
page routes verbatim. Changes:

- Drop `BASE_URL` and the `PROXIED` forwarding block entirely.
- At startup: `const sql = createSqlExecutorFromEnv()`. If `undefined`, print
  `metrics dashboard: COMPASS_VERDICT_DB_URL is required (Supabase transaction-pooler URL, port 6543)`
  to stderr and `process.exit(1)`.
- Build once, at startup, not per request:
  ```ts
  const metrics = createMetricsService({
    verdictStore: createPgVerdictStore({ sql }),
    credentialStore: createPgCredentialStore({ sql }),
  });
  ```
- `GET /v1/metrics` → `metrics.computeMetrics()` as JSON 200; on a thrown error,
  respond 500 `{ error: { code: "METRICS_FAILED", message: String(error) } }` and log
  it. A DB failure must be visible as an error, never an empty dashboard.
- `GET /health` → `{ ok: true }` 200 (the page probes it to resolve its base; it no
  longer means "the hosted API is up").
- Bind `127.0.0.1` (already the case — keep it).
- Everything else 404s, as today.

### T3 — `package.json` script

Add to `scripts`: `"metrics": "tsx scripts/metrics-dashboard.ts"`. Colleague-facing
command becomes `COMPASS_VERDICT_DB_URL='<pooler url>' npm run metrics`.

### T4 — page copy: drop the key gate

`scripts/metrics-dashboard.html` — the ONLY edits in this file:

- Remove the `#connect` section (the key form) and the `KEY_STORAGE` /
  `localStorage` logic; on load, resolve the base and fetch directly.
- Remove the "Change key" button from `.dash-meta`; keep "Refresh".
- Update the gate copy that names an API key. Chart, tiles, table, palette, and
  `fmtSeconds` are untouched.

### T5 — smoke script

`scripts/metrics-live.sh` currently mints a token and asserts `GET /v1/metrics`
returns 200. Rewrite its metrics section to: start nothing, instead `curl` the
LOCAL launcher (`http://localhost:${PORT:-4400}/v1/metrics`, no auth header) and
assert the same fields it asserts today (`onboarding.users >= 1`,
`fundsSecured.totals.totalUsd >= 0`, `byDay` non-empty). Keep the `/v1/verify`
allow+deny checks against `BASE_URL` — those still test the hosted API and are
unrelated to metrics transport.

### T6 — docs

- `docs/plans/2026-07-26-usage-metrics.md`: add "Addendum 4 (superseded transport)"
  noting T3's route and Addendum 3's auth gate are removed by this plan, with the
  reason (operator holds DB access; endpoint surface deleted rather than defended).
- `README.md` / `public/quickstart.md`: no `/v1/metrics` row exists in either
  (verified by grep 2026-07-26) — confirm still true, add nothing.

## Verification

- `npx vitest run --config vitest.back.config.ts` green (expect ~527 tests: 532
  minus the five deleted route tests).
- `npm run lint` green.
- `grep -rn "v1/metrics" hosted/ app/` returns only comment references in
  `verifyValidators.ts` — no route, no wiring.
- End-to-end, against the real DB:
  `COMPASS_VERDICT_DB_URL='<pooler url>' npm run metrics`, open
  `http://localhost:4400/`, confirm the hero figure, chart, and per-user table render
  with production numbers and NO key prompt.
- Negative: run with `COMPASS_VERDICT_DB_URL` unset → exits 1 with the T2 message,
  does not start a server showing zeros.
- Confirm the deployed API no longer serves it: after redeploy,
  `curl -s -o /dev/null -w "%{http_code}" https://www.compassguard.xyz/v1/metrics -H "Authorization: Bearer <operator key>"`
  → **404**.

## Risks

- **Zeros-as-data.** The one failure mode that looks like success. Mitigated by the
  hard exit in T2 and the 500-on-error rule; do not add an in-memory fallback.
- **Read-only credential.** The launcher only ever SELECTs (`list()`,
  `listIssued()`), but `COMPASS_VERDICT_DB_URL` is a read/write connection string.
  Consider issuing a read-only Postgres role for dashboard users — out of scope here,
  worth a follow-up ticket.
- **Schema-ensure on connect.** Both Pg stores run `CREATE TABLE IF NOT EXISTS` +
  idempotent migrations on first query. Against a provisioned DB this is a no-op, but
  it means the dashboard is not strictly read-only at the DDL level. A read-only role
  (above) would surface this as a permission error — verify before granting one.

## Non-goals

No change to metric definitions, `MetricsResponse`, the service, its tests, or the
dashboard's visual design. No new env vars. No changes to `/verify` or `/signup`.
