import { describe, expect, it, vi } from "vitest";

import { createBetaClickMetricsReader } from "./betaClickMetrics";

describe("createBetaClickMetricsReader", () => {
	it("treats an absent event table as an empty all-time dataset", async () => {
		const sql = vi.fn().mockResolvedValue([{ table_name: null }]);

		await expect(createBetaClickMetricsReader(sql).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
			bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
		});
		expect(sql).toHaveBeenCalledOnce();
		expect(sql).toHaveBeenCalledWith(expect.stringContaining("to_regclass"), []);
	});

	it("zero-fills an existing empty event table", async () => {
		const sql = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "beta_click_events" }])
			.mockResolvedValueOnce([]);

		await expect(createBetaClickMetricsReader(sql).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
			bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
		});
	});

	it("counts every persisted event and returns the fixed source breakdown", async () => {
		const sql = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "beta_click_events" }])
			.mockResolvedValueOnce([
				{ source: "hero", click_count: "4" },
				{ source: "nav", click_count: "2" },
				{ source: "unknown", click_count: "3" },
			]);

		await expect(createBetaClickMetricsReader(sql).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 9,
			bySource: { nav: 2, hero: 4, closing: 0, unknown: 3 },
		});
		const aggregateQuery = sql.mock.calls[1][0];
		expect(aggregateQuery).toContain("COUNT(*)");
		expect(aggregateQuery).toContain("GROUP BY source");
		expect(aggregateQuery).not.toMatch(/\bWHERE\b/i);
		expect(aggregateQuery).not.toMatch(/\bDISTINCT\b/i);
	});

	it("fails closed on a corrupt persisted source", async () => {
		const sql = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "beta_click_events" }])
			.mockResolvedValueOnce([{ source: "other", click_count: "1" }]);

		await expect(createBetaClickMetricsReader(sql).readAllTime()).rejects.toThrow(
			"Invalid beta click source",
		);
	});

	it("propagates database failures instead of returning zero", async () => {
		const probeFailure = new Error("probe unavailable");
		const queryFailure = new Error("aggregate unavailable");
		const failingProbe = vi.fn().mockRejectedValue(probeFailure);
		const failingQuery = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "beta_click_events" }])
			.mockRejectedValueOnce(queryFailure);

		await expect(createBetaClickMetricsReader(failingProbe).readAllTime()).rejects.toBe(
			probeFailure,
		);
		await expect(createBetaClickMetricsReader(failingQuery).readAllTime()).rejects.toBe(
			queryFailure,
		);
	});
});
