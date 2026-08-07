import {
	createPostgresClientFromEnv,
	readEnv,
} from "../db/sqlExecutorFromEnv";
import type { WaitlistMetricsQuery } from "./metricsContracts";

type TableProbeRow = { table_name: unknown };
type CountRow = { total: unknown };

/**
 * Safe Postgres adapter for the local waitlist dashboard metric. Queries are fixed tagged
 * templates: this boundary accepts no SQL text, identifiers, or fragments from callers.
 */
export function createWaitlistMetricsQueryFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): WaitlistMetricsQuery | undefined {
	const sql = createPostgresClientFromEnv(getEnv);
	if (!sql) return undefined;

	return {
		async tableExists(): Promise<boolean> {
			const rows = await sql<TableProbeRow[]>`
				SELECT to_regclass('waitlist_signups') AS table_name
			`;
			if (rows.length !== 1 || !("table_name" in rows[0])) {
				throw new Error("Invalid waitlist table probe result.");
			}
			if (rows[0].table_name === null) return false;
			if (typeof rows[0].table_name !== "string") {
				throw new Error("Invalid waitlist table probe result.");
			}
			return true;
		},

		async countAllTime(): Promise<unknown> {
			const rows = await sql<CountRow[]>`
				SELECT COUNT(*)::text AS total
				FROM waitlist_signups
			`;
			return rows[0]?.total;
		},
	};
}
