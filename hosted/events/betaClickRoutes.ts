import { Hono } from "hono";

import type { SqlExecutor } from "../verdict/verdictStorePg";
import { BETA_CLICK_SOURCES } from "./betaClickContracts";

const ALLOWED_ORIGINS = new Set([
	"https://compassguard.xyz",
	"https://www.compassguard.xyz",
]);
const SOURCES = new Set<string>(BETA_CLICK_SOURCES);
const SQL_SOURCES = BETA_CLICK_SOURCES.map((source) => `'${source}'`).join(", ");

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS beta_click_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	source text NOT NULL CHECK (source IN (${SQL_SOURCES})),
	clicked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

export function createBetaClickRoutes(sql: SqlExecutor | undefined): Hono {
	const routes = new Hono();
	let ensured: Promise<void> | undefined;

	function ensureSchema(): Promise<void> {
		if (!sql) return Promise.reject(new Error("Beta click storage is unavailable."));
		if (ensured) return ensured;
		const promise = (async () => {
			try {
				await sql(CREATE_TABLE, []);
			} catch (error) {
				const probe = await sql(`SELECT to_regclass('beta_click_events') AS t`, []);
				if (probe[0]?.t == null) throw error;
			}
		})();
		ensured = promise;
		promise.catch(() => {
			if (ensured === promise) ensured = undefined;
		});
		return promise;
	}

	routes.post("/events/beta-click", async (context) => {
		if (!ALLOWED_ORIGINS.has(context.req.header("Origin") ?? "")) {
			return context.body(null, 403);
		}

		const body = await context.req.json().catch(() => undefined);
		const source = typeof body?.source === "string" ? body.source.trim().toLowerCase() : "";
		if (!SOURCES.has(source)) return context.body(null, 400);
		if (!sql) {
			return context.json(
				{ error: { code: "SERVICE_UNAVAILABLE", message: "Beta click storage is unavailable." } },
				503,
			);
		}

		try {
			await ensureSchema();
			await sql("INSERT INTO beta_click_events (source) VALUES ($1)", [source]);
		} catch {
			return context.json(
				{ error: { code: "SERVICE_UNAVAILABLE", message: "Beta click storage is unavailable." } },
				503,
			);
		}
		return context.body(null, 204);
	});

	return routes;
}
