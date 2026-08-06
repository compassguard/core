import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/sqlExecutorFromEnv", () => ({
	createPostgresClientFromEnv: vi.fn(),
	readEnv: vi.fn(),
}));

import { createPostgresClientFromEnv } from "../db/sqlExecutorFromEnv";
import { createBetaClickMetricsQueryFromEnv } from "./betaClickMetricsPg";

const clientFromEnv = vi.mocked(createPostgresClientFromEnv);

describe("createBetaClickMetricsQueryFromEnv", () => {
	beforeEach(() => {
		clientFromEnv.mockReset();
	});

	it("returns undefined when the database is not configured", () => {
		clientFromEnv.mockReturnValue(undefined);

		expect(createBetaClickMetricsQueryFromEnv()).toBeUndefined();
	});

	it("uses only fixed tagged templates for the table probe and all-time aggregate", async () => {
		const sql = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "beta_click_events" }])
			.mockResolvedValueOnce([{ source: "hero", click_count: "4" }]);
		clientFromEnv.mockReturnValue(sql as never);

		const query = createBetaClickMetricsQueryFromEnv();
		expect(query).toBeDefined();
		await expect(query?.tableExists()).resolves.toBe(true);
		await expect(query?.aggregateAllTime()).resolves.toEqual([
			{ source: "hero", clickCount: "4" },
		]);

		for (const call of sql.mock.calls) {
			const [template, ...parameters] = call;
			expect(Array.isArray(template)).toBe(true);
			expect(Array.isArray((template as TemplateStringsArray).raw)).toBe(true);
			expect(parameters).toEqual([]);
		}
		const aggregateSql = (sql.mock.calls[1][0] as TemplateStringsArray).join("");
		expect(aggregateSql).toContain("COUNT(*)");
		expect(aggregateSql).toContain("GROUP BY source");
		expect(aggregateSql).not.toMatch(/\bWHERE\b|\bDISTINCT\b/i);
	});

	it("fails closed on an invalid table probe result", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		clientFromEnv.mockReturnValue(sql as never);

		await expect(createBetaClickMetricsQueryFromEnv()?.tableExists()).rejects.toThrow(
			"Invalid beta click table probe result.",
		);
	});
});
