// Metrics response contract — frozen in docs/plans/2026-07-26-usage-metrics.md. Served by
// the local dashboard launcher (scripts/metrics-dashboard.ts), NOT by the hosted API: it
// carries every user's email, so it never crosses the internet (2026-07-26-metrics-db-direct.md).
// Read-only operator metrics computed from data already persisted (credentials, verdicts,
// and beta click events): onboarding time, funds secured, and aggregate beta-page clicks.

import type { BetaClickSource } from "../events/betaClickContracts";

export type BetaClickMetrics = {
	/** Fixed semantic scope: every persisted click event, with no date window. */
	period: "all_time";
	/** Count of persisted click events. This is never a unique-person count. */
	total: number;
	bySource: Record<BetaClickSource, number>;
};

export type BetaClickMetricsReader = {
	readAllTime(): Promise<BetaClickMetrics>;
};

export type BetaClickAggregateRow = {
	source: unknown;
	clickCount: unknown;
};

/** Domain query seam: callers select operations, never SQL text or identifiers. */
export type BetaClickMetricsQuery = {
	tableExists(): Promise<boolean>;
	aggregateAllTime(): Promise<readonly BetaClickAggregateRow[]>;
};

export type OnboardingPerUser = {
	email: string;
	signupAt: string;
	firstVerifyAt?: string;
	secondsToFirstVerify?: number;
	firstConfirmedTxAt?: string;
	secondsToFirstConfirmedTx?: number;
	firstFlaggedAt?: string;
	secondsToFirstFlagged?: number;
};

export type FundsBucket = {
	verdicts: number;
	withAmountUsd: number;
	totalUsd: number;
	allowUsd: number;
	reviewUsd: number;
	denyUsd: number;
	/** reviewUsd + denyUsd — funds the firewall stopped from moving unchecked. */
	possibleFundsLostUsd: number;
	/**
	 * Flagged (review/deny) verdicts carrying NO usd amount, so their value is unknown, not
	 * zero. possibleFundsLostUsd is a LOWER BOUND whenever this is > 0: /verify only derives
	 * amountUsd from amountUsd/amount_usd/usdAmount, so a blocked transfer denominated in SOL
	 * contributes nothing. Readers must show this alongside the figure rather than presenting
	 * an under-count as complete.
	 */
	flaggedWithoutAmount: number;
};

export type MetricsResponse = {
	generatedAt: string; // isoNow at compute time
	betaClicks: BetaClickMetrics;
	onboarding: {
		users: number; // distinct signup emails
		activated: number; // users with a firstVerifyAt
		confirmed: number; // users with a firstConfirmedTxAt
		flagged: number; // users with a firstFlaggedAt
		medianSecondsToFirstVerify: number | null;
		averageSecondsToFirstVerify: number | null;
		medianSecondsToFirstConfirmedTx: number | null;
		medianSecondsToFirstFlagged: number | null;
		averageSecondsToFirstFlagged: number | null;
		perUser: OnboardingPerUser[]; // sorted by signupAt ascending
	};
	fundsSecured: {
		totals: FundsBucket;
		byDay: Array<{ day: string } & FundsBucket>; // sorted by day ascending
	};
};

export type MetricsService = {
	computeMetrics(): Promise<MetricsResponse>;
};
