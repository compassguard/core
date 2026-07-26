import type { HostedDecision } from "@shared/evaluationContracts";

import type { CredentialStore } from "../credential/credentialStore";
import type { VerdictStore } from "../verdict/verdictStoreTypes";
import type {
	FundsBucket,
	MetricsResponse,
	MetricsService,
	OnboardingPerUser,
} from "./metricsContracts";

export type MetricsServiceDependencies = {
	verdictStore: VerdictStore;
	credentialStore: CredentialStore;
	isoNow?: () => string;
};

// Median: sort ascending; odd count → middle; even count → mean of the two middle
// values; empty → null.
function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emptyFundsBucket(): FundsBucket {
	return { verdicts: 0, withAmountUsd: 0, totalUsd: 0, allowUsd: 0, reviewUsd: 0, denyUsd: 0 };
}

function addToFundsBucket(
	bucket: FundsBucket,
	decision: HostedDecision,
	usd: number,
	hadAmount: boolean,
): void {
	bucket.verdicts += 1;
	if (hadAmount) bucket.withAmountUsd += 1;
	bucket.totalUsd += usd;
	if (decision === "allow") bucket.allowUsd += usd;
	else if (decision === "review") bucket.reviewUsd += usd;
	else if (decision === "deny") bucket.denyUsd += usd;
}

/**
 * Computes both operator metrics read-only from data already persisted (credentials +
 * verdicts) — no new event tracking, no schema migration. Backing-agnostic: the same code
 * path runs over in-memory and Pg stores because it only calls list()/listIssued().
 */
export function createMetricsService(deps: MetricsServiceDependencies): MetricsService {
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());

	return {
		async computeMetrics(): Promise<MetricsResponse> {
			const [verdicts, issued] = await Promise.all([
				deps.verdictStore.list(),
				deps.credentialStore.listIssued(),
			]);

			// signupAt per email = min(createdAt) across that email's credentials — revoked
			// credentials still mark signup.
			const signupByEmail = new Map<string, string>();
			for (const credential of issued) {
				const existing = signupByEmail.get(credential.email);
				if (existing === undefined || credential.createdAt < existing) {
					signupByEmail.set(credential.email, credential.createdAt);
				}
			}

			// firstVerifyAt / firstConfirmedTxAt per email — shared-key verdicts (no
			// authenticatedEmail) are excluded here (no honest join) but still feed fundsSecured.
			const firstVerifyByEmail = new Map<string, string>();
			const firstConfirmedByEmail = new Map<string, string>();
			for (const verdict of verdicts) {
				const email = verdict.authenticatedEmail;
				if (email === undefined) continue;

				const existingVerify = firstVerifyByEmail.get(email);
				if (existingVerify === undefined || verdict.decidedAt < existingVerify) {
					firstVerifyByEmail.set(email, verdict.decidedAt);
				}

				if (verdict.txSignature !== undefined && verdict.confirmedAt !== undefined) {
					const existingConfirmed = firstConfirmedByEmail.get(email);
					if (existingConfirmed === undefined || verdict.confirmedAt < existingConfirmed) {
						firstConfirmedByEmail.set(email, verdict.confirmedAt);
					}
				}
			}

			const perUser: OnboardingPerUser[] = [];
			for (const [email, signupAt] of signupByEmail.entries()) {
				const row: OnboardingPerUser = { email, signupAt };
				const firstVerifyAt = firstVerifyByEmail.get(email);
				if (firstVerifyAt !== undefined) {
					row.firstVerifyAt = firstVerifyAt;
					// decidedAt can be caller-supplied (requestedAt), so this can be negative —
					// the raw value is kept here; aggregates below exclude negatives.
					row.secondsToFirstVerify = (Date.parse(firstVerifyAt) - Date.parse(signupAt)) / 1000;
				}
				const firstConfirmedTxAt = firstConfirmedByEmail.get(email);
				if (firstConfirmedTxAt !== undefined) {
					row.firstConfirmedTxAt = firstConfirmedTxAt;
					row.secondsToFirstConfirmedTx =
						(Date.parse(firstConfirmedTxAt) - Date.parse(signupAt)) / 1000;
				}
				perUser.push(row);
			}
			perUser.sort((a, b) => a.signupAt.localeCompare(b.signupAt));

			const verifyDurations = perUser
				.map((user) => user.secondsToFirstVerify)
				.filter((seconds): seconds is number => seconds !== undefined && seconds >= 0);
			const confirmedDurations = perUser
				.map((user) => user.secondsToFirstConfirmedTx)
				.filter((seconds): seconds is number => seconds !== undefined && seconds >= 0);

			// Funds secured — over ALL verdicts (shared-key included; no email join needed).
			const totals = emptyFundsBucket();
			const byDayMap = new Map<string, FundsBucket>();
			for (const verdict of verdicts) {
				const hadAmount = verdict.intendedEffect.amountUsd !== undefined;
				const usd = verdict.intendedEffect.amountUsd ?? 0;
				addToFundsBucket(totals, verdict.decision, usd, hadAmount);

				const day = verdict.decidedAt.slice(0, 10);
				let dayBucket = byDayMap.get(day);
				if (dayBucket === undefined) {
					dayBucket = emptyFundsBucket();
					byDayMap.set(day, dayBucket);
				}
				addToFundsBucket(dayBucket, verdict.decision, usd, hadAmount);
			}
			const byDay = [...byDayMap.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([day, bucket]) => ({ day, ...bucket }));

			return {
				generatedAt: isoNow(),
				onboarding: {
					users: signupByEmail.size,
					activated: perUser.filter((user) => user.firstVerifyAt !== undefined).length,
					confirmed: perUser.filter((user) => user.firstConfirmedTxAt !== undefined).length,
					medianSecondsToFirstVerify: median(verifyDurations),
					averageSecondsToFirstVerify: average(verifyDurations),
					medianSecondsToFirstConfirmedTx: median(confirmedDurations),
					perUser,
				},
				fundsSecured: {
					totals,
					byDay,
				},
			};
		},
	};
}
