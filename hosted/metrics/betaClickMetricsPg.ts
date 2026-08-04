import {
	createPostgresClientFromEnv,
	readEnv,
} from "../db/sqlExecutorFromEnv";
import type {
	BetaClickAggregateRow,
	BetaClickMetricsQuery,
} from "./metricsContracts";

type TableProbeRow = { table_name: unknown };
type AggregateRow = { source: unknown; click_count: unknown };

/**
 * Safe Postgres adapter for the local beta-click dashboard metrics. Queries are fixed tagged
 * templates: this boundary accepts no SQL text, identifiers, or fragments from callers.
 */
export function createBetaClickMetricsQueryFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): BetaClickMetricsQuery | undefined {
	const sql = createPostgresClientFromEnv(getEnv);
	if (!sql) return undefined;

	return {
		async tableExists(): Promise<boolean> {
			const rows = await sql<TableProbeRow[]>`
				SELECT to_regclass('beta_click_events') AS table_name
			`;
			if (rows.length !== 1 || !("table_name" in rows[0])) {
				throw new Error("Invalid beta click table probe result.");
			}
			if (rows[0].table_name === null) return false;
			if (typeof rows[0].table_name !== "string") {
				throw new Error("Invalid beta click table probe result.");
			}
			return true;
		},

		async aggregateAllTime(): Promise<readonly BetaClickAggregateRow[]> {
			const rows = await sql<AggregateRow[]>`
				SELECT source, COUNT(*)::text AS click_count
				FROM beta_click_events
				GROUP BY source
			`;
			return rows.map((row) => ({
				source: row.source,
				clickCount: row.click_count,
			}));
		},
	};
}
