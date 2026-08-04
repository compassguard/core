import {
	BETA_CLICK_SOURCES,
	type BetaClickSource,
} from "../events/betaClickContracts";
import {
	type BetaClickMetrics,
	type BetaClickMetricsQuery,
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
export function createBetaClickMetricsReader(query: BetaClickMetricsQuery): BetaClickMetricsReader {
	return {
		async readAllTime(): Promise<BetaClickMetrics> {
			if (!(await query.tableExists())) return emptyMetrics();

			const rows = await query.aggregateAllTime();
			const metrics = emptyMetrics();
			const seen = new Set<BetaClickSource>();
			for (const row of rows) {
				if (typeof row.source !== "string" || !SOURCE_SET.has(row.source)) {
					throw new Error("Invalid beta click source in persisted data.");
				}
				const source = row.source as BetaClickSource;
				if (seen.has(source)) throw new Error("Duplicate beta click aggregate source.");
				seen.add(source);
				const count = parseCount(row.clickCount);
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
