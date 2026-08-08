import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createWaitlistMetricsReader } from "./waitlistMetrics";

describe("createWaitlistMetricsReader", () => {
	it("treats an absent waitlist table as an empty all-time dataset", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(false),
			countAllTime: vi.fn(),
		};

		await expect(createWaitlistMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
		});
		expect(query.tableExists).toHaveBeenCalledOnce();
		expect(query.countAllTime).not.toHaveBeenCalled();
	});

	it("zero-fills an existing empty waitlist table", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			countAllTime: vi.fn().mockResolvedValue("0"),
		};

		await expect(createWaitlistMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 0,
		});
	});

	it("counts every persisted signup", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			countAllTime: vi.fn().mockResolvedValue("7"),
		};

		await expect(createWaitlistMetricsReader(query).readAllTime()).resolves.toEqual({
			period: "all_time",
			total: 7,
		});
		expect(query.countAllTime).toHaveBeenCalledOnce();
	});

	it("fails closed on a corrupt persisted count", async () => {
		const query = {
			tableExists: vi.fn().mockResolvedValue(true),
			countAllTime: vi.fn().mockResolvedValue("not-a-number"),
		};

		await expect(createWaitlistMetricsReader(query).readAllTime()).rejects.toThrow(
			"Invalid waitlist aggregate count",
		);
	});

	it("propagates database failures instead of returning zero", async () => {
		const probeFailure = new Error("probe unavailable");
		const queryFailure = new Error("count unavailable");
		const failingProbe = {
			tableExists: vi.fn().mockRejectedValue(probeFailure),
			countAllTime: vi.fn(),
		};
		const failingQuery = {
			tableExists: vi.fn().mockResolvedValue(true),
			countAllTime: vi.fn().mockRejectedValue(queryFailure),
		};

		await expect(createWaitlistMetricsReader(failingProbe).readAllTime()).rejects.toBe(
			probeFailure,
		);
		await expect(createWaitlistMetricsReader(failingQuery).readAllTime()).rejects.toBe(
			queryFailure,
		);
	});

	it("keeps the metrics runtime off raw or dynamically constructed SQL", async () => {
		const [readerSource, pgSource, dashboardSource] = await Promise.all([
			readFile(new URL("./waitlistMetrics.ts", import.meta.url), "utf8"),
			readFile(new URL("./waitlistMetricsPg.ts", import.meta.url), "utf8"),
			readFile(new URL("../../scripts/metrics-dashboard.ts", import.meta.url), "utf8"),
		]);

		expect(readerSource).not.toMatch(/SqlExecutor|\bSELECT\b|\bFROM\b|\.unsafe\s*\(/);
		expect(pgSource).not.toMatch(/\.unsafe\s*\(|\bsql\s*\(/);
		expect(pgSource).not.toMatch(/`[^`]*\$\{[\s\S]*?`/);
		expect(pgSource.match(/await sql(?:<[^>]+>)?`/g)).toHaveLength(2);
		// Keep the dashboard's query object itself at the safe adapter boundary. Checking only
		// the reader call would allow a future raw text-executor-backed object to be assigned
		// to waitlistMetricsQuery before reaching the same reader call.
		const waitlistMetricsQueryInitializer = dashboardSource.match(
			/const waitlistMetricsQuery\s*=\s*([^;]+);/,
		)?.[1];
		expect(waitlistMetricsQueryInitializer).toBe("createWaitlistMetricsQueryFromEnv()");
		expect(dashboardSource).toContain("createWaitlistMetricsReader(waitlistMetricsQuery)");
	});
});
