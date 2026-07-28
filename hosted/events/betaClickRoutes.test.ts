import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createDefaultHostedAppDependencies, createHostedApp } from "../app";
import { createBetaClickRoutes } from "./betaClickRoutes";

const request = (body: string, origin = "https://compassguard.xyz") =>
	new Request("https://api.compassguard.xyz/events/beta-click", {
		method: "POST",
		headers: origin ? { Origin: origin, "Content-Type": "application/json" } : {},
		body,
	});

describe("beta click routes", () => {
	it("normalizes and persists an allowed source before returning 204", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		const response = await createBetaClickRoutes(sql).request(request('{"source":" HERO "}'));

		expect(response.status).toBe(204);
		expect(sql).toHaveBeenNthCalledWith(1, expect.stringContaining("beta_click_events"), []);
		expect(sql).toHaveBeenNthCalledWith(
			2,
			"INSERT INTO beta_click_events (source) VALUES ($1)",
			["hero"],
		);
	});

	it("rejects malformed and unsupported sources without writing", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		const routes = createBetaClickRoutes(sql);

		expect((await routes.request(request('{'))).status).toBe(400);
		expect((await routes.request(request('{"source":"other"}'))).status).toBe(400);
		expect((await routes.request(request('{"source":null}'))).status).toBe(400);
		expect(sql).not.toHaveBeenCalled();
	});

	it("rejects missing and disallowed origins", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		const routes = createBetaClickRoutes(sql);

		expect((await routes.request(request('{"source":"nav"}', ""))).status).toBe(403);
		expect((await routes.request(request('{"source":"nav"}', "https://evil.example"))).status).toBe(403);
		expect(sql).not.toHaveBeenCalled();
	});

	it("fails closed when durable storage is unavailable", async () => {
		const response = await createBetaClickRoutes(undefined).request(request('{"source":"nav"}'));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: { code: "SERVICE_UNAVAILABLE", message: "Beta click storage is unavailable." },
		});
	});

	it("fails closed without exposing executor errors", async () => {
		const response = await createBetaClickRoutes(
			vi.fn().mockRejectedValue(new Error("database password leaked")),
		).request(request('{"source":"nav"}'));

		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("database password leaked");
	});

	it("uses a constrained timestamped Postgres schema", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		await createBetaClickRoutes(sql).request(request('{"source":"nav"}'));

		const schema = sql.mock.calls[0][0];
		expect(schema).toContain("GENERATED ALWAYS AS IDENTITY PRIMARY KEY");
		expect(schema).toContain("CHECK (source IN ('nav', 'hero', 'closing', 'unknown'))");
		expect(schema).toContain("clicked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP");
	});

	it("is wired as a public hosted route and has its Vercel rewrite", async () => {
		const app = createHostedApp(createDefaultHostedAppDependencies({}));
		const response = await app.request("/events/beta-click", request('{"source":"nav"}'));
		expect(response.status).toBe(503);

		const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8")) as {
			rewrites: Array<{ source: string; destination: string }>;
		};
		expect(config.rewrites).toContainEqual({
			source: "/events/beta-click",
			destination: "/api/hosted/events/beta-click",
		});
	});
});
