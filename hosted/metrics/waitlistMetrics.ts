import type {
	WaitlistMetrics,
	WaitlistMetricsQuery,
	WaitlistMetricsReader,
} from "./metricsContracts";

function emptyMetrics(): WaitlistMetrics {
	return { period: "all_time", total: 0 };
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
		throw new Error("Invalid waitlist aggregate count.");
	}
	return parsed;
}

/**
 * Reads an aggregate-only, all-time signup count directly from the persisted waitlist table.
 * Absence of the table is an empty dataset; query failures and a corrupt aggregate value fail.
 */
export function createWaitlistMetricsReader(query: WaitlistMetricsQuery): WaitlistMetricsReader {
	return {
		async readAllTime(): Promise<WaitlistMetrics> {
			if (!(await query.tableExists())) return emptyMetrics();

			const total = parseCount(await query.countAllTime());
			return { period: "all_time", total };
		},
	};
}
