// Response contract for GET /v1/metrics — frozen in docs/plans/2026-07-26-usage-metrics.md.
// Two read-only operator metrics computed from data already persisted (credentials +
// verdicts): onboarding time (signup → first guarded action / first confirmed tx) and
// funds secured (USD screened by the firewall, by day and total).

export type OnboardingPerUser = {
	email: string;
	signupAt: string;
	firstVerifyAt?: string;
	secondsToFirstVerify?: number;
	firstConfirmedTxAt?: string;
	secondsToFirstConfirmedTx?: number;
};

export type FundsBucket = {
	verdicts: number;
	withAmountUsd: number;
	totalUsd: number;
	allowUsd: number;
	reviewUsd: number;
	denyUsd: number;
};

export type MetricsResponse = {
	generatedAt: string; // isoNow at compute time
	onboarding: {
		users: number; // distinct signup emails
		activated: number; // users with a firstVerifyAt
		confirmed: number; // users with a firstConfirmedTxAt
		medianSecondsToFirstVerify: number | null;
		averageSecondsToFirstVerify: number | null;
		medianSecondsToFirstConfirmedTx: number | null;
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
