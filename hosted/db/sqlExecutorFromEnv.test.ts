import { describe, expect, it } from "vitest";

import { createSqlExecutorFromEnv } from "./sqlExecutorFromEnv";

// Build a getEnv from a plain map; missing keys resolve to undefined (like process.env).
const env =
	(map: Record<string, string>) =>
	(key: string): string | undefined =>
		map[key];

describe("createSqlExecutorFromEnv — production durability guard", () => {
	it("returns undefined (in-memory fallback) when the URL is unset outside production", () => {
		expect(createSqlExecutorFromEnv(env({}))).toBeUndefined();
		expect(createSqlExecutorFromEnv(env({ NODE_ENV: "development" }))).toBeUndefined();
		expect(createSqlExecutorFromEnv(env({ NODE_ENV: "test" }))).toBeUndefined();
	});

	it("keeps the in-memory fallback on a Vercel preview/development deploy (VERCEL_ENV != production)", () => {
		// Vercel builds run with NODE_ENV=production even for previews, so VERCEL_ENV is the
		// authoritative signal there — a preview may legitimately run without a durable store.
		expect(
			createSqlExecutorFromEnv(env({ VERCEL_ENV: "preview", NODE_ENV: "production" })),
		).toBeUndefined();
		expect(
			createSqlExecutorFromEnv(env({ VERCEL_ENV: "development", NODE_ENV: "production" })),
		).toBeUndefined();
	});

	it("throws when the URL is unset on a Vercel production deploy (VERCEL_ENV=production)", () => {
		expect(() =>
			createSqlExecutorFromEnv(env({ VERCEL_ENV: "production" })),
		).toThrow(/COMPASS_VERDICT_DB_URL is required in production/);
	});

	it("throws when the URL is unset with NODE_ENV=production off Vercel (self-hosted prod)", () => {
		expect(() =>
			createSqlExecutorFromEnv(env({ NODE_ENV: "production" })),
		).toThrow(/COMPASS_VERDICT_DB_URL is required in production/);
	});

	it("treats a blank/whitespace URL as unset — still fails loudly in production", () => {
		expect(() =>
			createSqlExecutorFromEnv(env({ COMPASS_VERDICT_DB_URL: "   ", VERCEL_ENV: "production" })),
		).toThrow(/COMPASS_VERDICT_DB_URL is required in production/);
	});
});
