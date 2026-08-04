import type { SqlExecutor } from "../verdict/verdictStorePg";
import {
	BETA_CLICK_SOURCES,
	type BetaClickSource,
} from "../events/betaClickContracts";
import {
	type BetaClickMetrics,
	type BetaClickMetricsReader,
} from "./metricsContracts";

const SOURCE_SET = new Set<string>(BETA_CLICK_SOURCES);

function emptyMetrics(): BetaClickMetrics {
	return {
		period: "all_time",
		total: 0,
		bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
	};
}

function parseCount(value: unknown): number {
	const parsed =
		typeof value === "bigint"
			? Number(value)
			: typeof value === "number"
				? value
				: typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
					? Number(value)
					: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("Invalid beta click aggregate count.");
	}
	return parsed;
}

/**
 * Reads aggregate-only, all-time click counts directly from the persisted event table.
 * Absence of the table is an empty dataset; query failures and corrupt aggregate rows fail.
 */
export function createBetaClickMetricsReader(sql: SqlExecutor): BetaClickMetricsReader {
	return {
		async readAllTime(): Promise<BetaClickMetrics> {
			const probe = await sql(`SELECT to_regclass('beta_click_events') AS table_name`, []);
			if (probe.length !== 1 || !("table_name" in probe[0])) {
				throw new Error("Invalid beta click table probe result.");
			}
			if (probe[0].table_name === null) return emptyMetrics();
			if (typeof probe[0].table_name !== "string") {
				throw new Error("Invalid beta click table probe result.");
			}

			const rows = await sql(
				`SELECT source, COUNT(*)::text AS click_count
				 FROM beta_click_events
				 GROUP BY source`,
				[],
			);
			const metrics = emptyMetrics();
			const seen = new Set<BetaClickSource>();
			for (const row of rows) {
				if (typeof row.source !== "string" || !SOURCE_SET.has(row.source)) {
					throw new Error("Invalid beta click source in persisted data.");
				}
				const source = row.source as BetaClickSource;
				if (seen.has(source)) throw new Error("Duplicate beta click aggregate source.");
				seen.add(source);
				const count = parseCount(row.click_count);
				metrics.bySource[source] = count;
				metrics.total += count;
				if (!Number.isSafeInteger(metrics.total)) {
					throw new Error("Beta click aggregate total exceeds the safe integer range.");
				}
			}
			return metrics;
		},
	};
}
