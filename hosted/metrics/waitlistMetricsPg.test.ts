import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/sqlExecutorFromEnv", () => ({
	createPostgresClientFromEnv: vi.fn(),
	readEnv: vi.fn(),
}));

import { createPostgresClientFromEnv } from "../db/sqlExecutorFromEnv";
import { createWaitlistMetricsQueryFromEnv } from "./waitlistMetricsPg";

const clientFromEnv = vi.mocked(createPostgresClientFromEnv);

describe("createWaitlistMetricsQueryFromEnv", () => {
	beforeEach(() => {
		clientFromEnv.mockReset();
	});

	it("returns undefined when the database is not configured", () => {
		clientFromEnv.mockReturnValue(undefined);

		expect(createWaitlistMetricsQueryFromEnv()).toBeUndefined();
	});

	it("uses only fixed tagged templates for the table probe and all-time count", async () => {
		const sql = vi
			.fn()
			.mockResolvedValueOnce([{ table_name: "waitlist_signups" }])
			.mockResolvedValueOnce([{ total: "7" }]);
		clientFromEnv.mockReturnValue(sql as never);

		const query = createWaitlistMetricsQueryFromEnv();
		expect(query).toBeDefined();
		await expect(query?.tableExists()).resolves.toBe(true);
		await expect(query?.countAllTime()).resolves.toBe("7");

		for (const call of sql.mock.calls) {
			const [template, ...parameters] = call;
			expect(Array.isArray(template)).toBe(true);
			expect(Array.isArray((template as TemplateStringsArray).raw)).toBe(true);
			expect(parameters).toEqual([]);
		}
		const countSql = (sql.mock.calls[1][0] as TemplateStringsArray).join("");
		expect(countSql).toContain("COUNT(*)");
		expect(countSql).not.toMatch(/\bWHERE\b|\bDISTINCT\b|\bGROUP BY\b/i);
	});

	it("fails closed on an invalid table probe result", async () => {
		const sql = vi.fn().mockResolvedValue([]);
		clientFromEnv.mockReturnValue(sql as never);

		await expect(createWaitlistMetricsQueryFromEnv()?.tableExists()).rejects.toThrow(
			"Invalid waitlist table probe result.",
		);
	});
});
