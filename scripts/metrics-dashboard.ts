#!/usr/bin/env -S npx tsx
// Internal metrics dashboard — NOT deployed, never internet-facing.
//
// Computes the metrics HERE, from the database, and serves them to a localhost
// page. There is deliberately no hosted /v1/metrics endpoint: the response carries
// every user's email, and an internet-facing route would need an operator-only auth
// gate maintained forever (see docs/plans/2026-07-26-metrics-db-direct.md). Whoever
// reads this dashboard already has DB access, so the endpoint bought nothing.
//
// Usage:
//   COMPASS_VERDICT_DB_URL='<supabase pooler url>' npm run metrics
//   PORT=4401 COMPASS_VERDICT_DB_URL='…' npm run metrics
//
// Then open the printed URL. No API key, no auth prompt — the DB URL stays in this
// process and never reaches the browser.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSqlExecutorFromEnv } from "../hosted/db/sqlExecutorFromEnv";
import { createPgCredentialStore } from "../hosted/credential/credentialStorePg";
import { createBetaClickMetricsReader } from "../hosted/metrics/betaClickMetrics";
import { createBetaClickMetricsQueryFromEnv } from "../hosted/metrics/betaClickMetricsPg";
import { createPgVerdictStore } from "../hosted/verdict/verdictStorePg";
import { createMetricsService } from "../hosted/metrics/metricsService";

const PORT = Number.parseInt(process.env.PORT ?? "4400", 10);
const HTML_PATH =
	process.env.METRICS_HTML ?? join(dirname(fileURLToPath(import.meta.url)), "metrics-dashboard.html");

// FAIL LOUDLY on a missing URL. The Pg store factories' env-selected siblings fall back
// to in-memory when no URL is set, which would serve a perfectly-rendered EMPTY dashboard
// — zeros indistinguishable from "no activity yet". That is the one failure mode here
// that looks like success, so it must never be reachable.
const sql = createSqlExecutorFromEnv();
const betaClickMetricsQuery = createBetaClickMetricsQueryFromEnv();
if (!sql || !betaClickMetricsQuery) {
	console.error(
		"metrics dashboard: COMPASS_VERDICT_DB_URL is required (Supabase transaction-pooler URL, port 6543).",
	);
	process.exit(1);
}

// Built once at startup, not per request: createSqlExecutorFromEnv caches one pooler
// client per URL, and the stores are stateless wrappers over it.
const metrics = createMetricsService({
	verdictStore: createPgVerdictStore({ sql }),
	credentialStore: createPgCredentialStore({ sql }),
	betaClickMetricsReader: createBetaClickMetricsReader(betaClickMetricsQuery),
});

const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;

	if (path === "/" || path === "/metrics") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		response.end(readFileSync(HTML_PATH, "utf-8"));
		return;
	}

	// The page probes /health to resolve its API base. Here it means only "this launcher
	// is up" — there is no upstream API in this topology.
	if (path === "/health" && request.method === "GET") {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ ok: true, service: "compass-metrics-dashboard" }));
		return;
	}

	if (path === "/v1/metrics" && request.method === "GET") {
		try {
			const body = await metrics.computeMetrics();
			response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(JSON.stringify(body));
		} catch (error) {
			// A DB failure must surface as an ERROR, never as an empty dashboard.
			console.error("metrics computation failed:", error);
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { code: "METRICS_FAILED", message: String(error) } }));
		}
		return;
	}

	response.writeHead(404, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not part of the metrics dashboard." } }));
});

// Loopback only — this serves unauthenticated PII by design, so it must never bind a
// routable interface.
server.listen(PORT, "127.0.0.1", () => {
	console.info(`Compass metrics dashboard → http://localhost:${PORT}/  (reading the database directly)`);
});
