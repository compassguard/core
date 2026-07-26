#!/usr/bin/env node
// Internal metrics dashboard launcher — NOT deployed. Serves
// scripts/metrics-dashboard.html on localhost and proxies /health and
// /v1/metrics to the target API, so the page is same-origin (the hosted API
// sends no CORS headers, and an internal page must not require adding any).
//
// Usage:
//   node scripts/metrics-dashboard.mjs                                # against prod
//   BASE_URL=http://localhost:3001 node scripts/metrics-dashboard.mjs # local backend
//   PORT=4401 node scripts/metrics-dashboard.mjs
//
// Then open the printed URL and paste an API key (stored in that browser only).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = (process.env.BASE_URL ?? "https://www.compassguard.xyz").replace(/\/$/, "");
const PORT = Number.parseInt(process.env.PORT ?? "4400", 10);
const HTML_PATH =
	process.env.METRICS_HTML ?? join(dirname(fileURLToPath(import.meta.url)), "metrics-dashboard.html");

// Only these exact API paths are proxied — the launcher must never become a
// general open proxy.
const PROXIED = new Set(["/health", "/v1/metrics"]);

const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;

	if (path === "/" || path === "/metrics") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		response.end(readFileSync(HTML_PATH, "utf-8"));
		return;
	}

	if (PROXIED.has(path) && request.method === "GET") {
		try {
			const headers = {};
			if (request.headers.authorization) headers.Authorization = request.headers.authorization;
			const upstream = await fetch(BASE_URL + path, { headers });
			const body = await upstream.text();
			response.writeHead(upstream.status, {
				"Content-Type": upstream.headers.get("content-type") ?? "application/json",
			});
			response.end(body);
		} catch (error) {
			response.writeHead(502, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { code: "UPSTREAM_UNREACHABLE", message: String(error) } }));
		}
		return;
	}

	response.writeHead(404, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not part of the metrics dashboard." } }));
});

server.listen(PORT, "127.0.0.1", () => {
	console.info(`Compass metrics dashboard → http://localhost:${PORT}/  (API: ${BASE_URL})`);
});
