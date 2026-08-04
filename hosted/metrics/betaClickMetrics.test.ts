import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createBetaClickMetricsReader } from "./betaClickMetrics";

describe("createBetaClickMetricsReader", () => {
	it("treats an absent event table as an empty all-time dataset", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(false),
			aggregateAllTime: vi.fn(),
		};

		await expect(createBetaClickMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
			bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
		});
		expect(query.tableExists).toHaveBeenCalledOnce();
		expect(query.aggregateAllTime).not.toHaveBeenCalled();
	});

	it("zero-fills an existing empty event table", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			aggregateAllTime: vi.fn().mockResolvedValue([]),
		};

		await expect(createBetaClickMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
			bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
		});
	});

	it("counts every persisted event and returns the fixed source breakdown", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			aggregateAllTime: vi.fn().mockResolvedValue([
				{ source: "hero", clickCount: "4" },
				{ source: "nav", clickCount: "2" },
				{ source: "unknown", clickCount: "3" },
			]),
		};

		await expect(createBetaClickMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 9,
			bySource: { nav: 2, hero: 4, closing: 0, unknown: 3 },
		});
		expect(query.aggregateAllTime).toHaveBeenCalledOnce();
	});

	it("fails closed on a corrupt persisted source", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			aggregateAllTime: vi.fn().mockResolvedValue([{ source: "other", clickCount: "1" }]),
		};

		await expect(createBetaClickMetricsReader(query).readAllTime()).rejects.toThrow(
			"Invalid beta click source",
		);
	});

	it("propagates database failures instead of returning zero", async () => {
		const probeFailure = new Error("probe unavailable");
		const queryFailure = new Error("aggregate unavailable");
		const failingProbe = {
			tableExists: vi.fn().mockRejectedValue(probeFailure),
			aggregateAllTime: vi.fn(),
		};
		const failingQuery = {
			tableExists: vi.fn().mockResolvedValue(true),
			aggregateAllTime: vi.fn().mockRejectedValue(queryFailure),
		};

		await expect(createBetaClickMetricsReader(failingProbe).readAllTime()).rejects.toBe(
			probeFailure,
		);
		await expect(createBetaClickMetricsReader(failingQuery).readAllTime()).rejects.toBe(
			queryFailure,
		);
	});

	it("keeps the metrics runtime off raw or dynamically constructed SQL", async () => {
		const [readerSource, pgSource, dashboardSource] = await Promise.all([
			readFile(new URL("./betaClickMetrics.ts", import.meta.url), "utf8"),
			readFile(new URL("./betaClickMetricsPg.ts", import.meta.url), "utf8"),
			readFile(new URL("../../scripts/metrics-dashboard.ts", import.meta.url), "utf8"),
		]);

		expect(readerSource).not.toMatch(/SqlExecutor|\bSELECT\b|\bFROM\b|\.unsafe\s*\(/);
		expect(pgSource).not.toMatch(/\.unsafe\s*\(|\bsql\s*\(/);
		expect(pgSource).not.toMatch(/`[^`]*\$\{[\s\S]*?`/);
		expect(pgSource.match(/await sql(?:<[^>]+>)?`/g)).toHaveLength(2);
		// Keep the dashboard's query object itself at the safe adapter boundary. Checking only
		// the reader call would allow a future raw text-executor-backed object to be assigned
		// to betaClickMetricsQuery before reaching the same reader call.
		const betaClickMetricsQueryInitializer = dashboardSource.match(
			/const betaClickMetricsQuery\s*=\s*([^;]+);/,
		)?.[1];
		expect(betaClickMetricsQueryInitializer).toBe("createBetaClickMetricsQueryFromEnv()");
		expect(dashboardSource).toContain("createBetaClickMetricsReader(betaClickMetricsQuery)");
	});
});
