import type { HostedDecision } from "@shared/evaluationContracts";

import type { CredentialStore } from "../credential/credentialStore";
import type { VerdictStore } from "../verdict/verdictStoreTypes";
import type {
	BetaClickMetricsReader,
	FundsBucket,
	MetricsResponse,
	MetricsService,
	OnboardingPerUser,
	WaitlistMetricsReader,
} from "./metricsContracts";

export type MetricsServiceDependencies = {
	verdictStore: VerdictStore;
	credentialStore: CredentialStore;
	betaClickMetricsReader: BetaClickMetricsReader;
	waitlistMetricsReader: WaitlistMetricsReader;
	isoNow?: () => string;
};

/**
 * Instant of an ISO timestamp, or undefined when unparseable.
 *
 * Timestamps reaching here are NOT all `…Z`: /verify accepts any Date.parse-able
 * `requestedAt` (verifyValidators), so `2026-07-26T10:00:00+02:00` is valid input. Ordering
 * such values as raw strings compares the local wall clock, not the instant — "09:00Z" sorts
 * before "10:00+02:00" though the latter is 08:00Z and genuinely earlier. Every ordering and
 * bucketing decision below therefore goes through this, never through string compare.
 */
function epochMs(iso: string): number | undefined {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** True when `candidate` is strictly earlier than `incumbent` as an INSTANT. */
function isEarlier(candidate: string, incumbent: string): boolean {
	const candidateMs = epochMs(candidate);
	const incumbentMs = epochMs(incumbent);
	// An unorderable candidate never displaces a parseable incumbent; an unparseable
	// incumbent yields to anything parseable.
	if (candidateMs === undefined) return false;
	if (incumbentMs === undefined) return true;
	return candidateMs < incumbentMs;
}

/**
 * UTC calendar day (YYYY-MM-DD) of an ISO timestamp. Normalizes offsets first: a
 * `2026-07-27T00:30:00+02:00` verdict happened on the 26th in UTC, and slicing the raw
 * string would file it under the 27th. Falls back to the raw prefix for an unparseable
 * value so a corrupt legacy row buckets oddly rather than throwing RangeError.
 */
function utcDay(iso: string): string {
	const ms = epochMs(iso);
	return ms === undefined ? iso.slice(0, 10) : new Date(ms).toISOString().slice(0, 10);
}

/** Elapsed seconds between two ISO timestamps; undefined when either is unparseable. */
function secondsBetween(from: string, to: string): number | undefined {
	const fromMs = epochMs(from);
	const toMs = epochMs(to);
	if (fromMs === undefined || toMs === undefined) return undefined;
	return (toMs - fromMs) / 1000;
}

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
	return {
		verdicts: 0,
		withAmountUsd: 0,
		totalUsd: 0,
		allowUsd: 0,
		reviewUsd: 0,
		denyUsd: 0,
		possibleFundsLostUsd: 0,
		flaggedWithoutAmount: 0,
	};
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
	// A flagged verdict with no amount is worth an UNKNOWN sum, not zero — counted so the
	// figure below can be read as the lower bound it is.
	if (!hadAmount && isFlagged(decision)) bucket.flaggedWithoutAmount += 1;
	// Recomputed (not accumulated) so it never drifts from its two inputs.
	bucket.possibleFundsLostUsd = bucket.reviewUsd + bucket.denyUsd;
}

// Flagged = review OR deny (the firewall stopped or held the action).
function isFlagged(decision: HostedDecision): boolean {
	return decision === "review" || decision === "deny";
}

/**
 * Computes operator metrics read-only from data already persisted — no new event tracking
 * or schema migration. Onboarding and funds remain store-agnostic; beta click and waitlist
 * totals each come from an injected aggregate reader so this service never receives
 * individual click rows or waitlist emails.
 */
export function createMetricsService(deps: MetricsServiceDependencies): MetricsService {
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());

	return {
		async computeMetrics(): Promise<MetricsResponse> {
			// Both Pg stores lazily ensure their schema. Keep their DDL and the subsequent
			// beta-event probe serial on the transaction-pooler connection; concurrent setup
			// can wait indefinitely.
			const verdicts = await deps.verdictStore.list();
			const issued = await deps.credentialStore.listIssued();
			const betaClicks = await deps.betaClickMetricsReader.readAllTime();
			const waitlist = await deps.waitlistMetricsReader.readAllTime();

			// signupAt per email = min(createdAt) across that email's credentials — revoked
			// credentials still mark signup.
			const signupByEmail = new Map<string, string>();
			for (const credential of issued) {
				const existing = signupByEmail.get(credential.email);
				if (existing === undefined || isEarlier(credential.createdAt, existing)) {
					signupByEmail.set(credential.email, credential.createdAt);
				}
			}

			// firstVerifyAt / firstConfirmedTxAt / firstFlaggedAt per email — shared-key verdicts
			// (no authenticatedEmail) are excluded here (no honest join) but still feed fundsSecured.
			const firstVerifyByEmail = new Map<string, string>();
			const firstConfirmedByEmail = new Map<string, string>();
			const firstFlaggedByEmail = new Map<string, string>();
			for (const verdict of verdicts) {
				const email = verdict.authenticatedEmail;
				if (email === undefined) continue;

				const existingVerify = firstVerifyByEmail.get(email);
				if (existingVerify === undefined || isEarlier(verdict.decidedAt, existingVerify)) {
					firstVerifyByEmail.set(email, verdict.decidedAt);
				}

				if (verdict.txSignature !== undefined && verdict.confirmedAt !== undefined) {
					const existingConfirmed = firstConfirmedByEmail.get(email);
					if (existingConfirmed === undefined || isEarlier(verdict.confirmedAt, existingConfirmed)) {
						firstConfirmedByEmail.set(email, verdict.confirmedAt);
					}
				}

				if (isFlagged(verdict.decision)) {
					const existingFlagged = firstFlaggedByEmail.get(email);
					if (existingFlagged === undefined || isEarlier(verdict.decidedAt, existingFlagged)) {
						firstFlaggedByEmail.set(email, verdict.decidedAt);
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
					// the raw value is kept here; aggregates below exclude negatives. An
					// unparseable pair leaves the seconds field absent rather than NaN.
					const seconds = secondsBetween(signupAt, firstVerifyAt);
					if (seconds !== undefined) row.secondsToFirstVerify = seconds;
				}
				const firstConfirmedTxAt = firstConfirmedByEmail.get(email);
				if (firstConfirmedTxAt !== undefined) {
					row.firstConfirmedTxAt = firstConfirmedTxAt;
					const seconds = secondsBetween(signupAt, firstConfirmedTxAt);
					if (seconds !== undefined) row.secondsToFirstConfirmedTx = seconds;
				}
				const firstFlaggedAt = firstFlaggedByEmail.get(email);
				if (firstFlaggedAt !== undefined) {
					row.firstFlaggedAt = firstFlaggedAt;
					const seconds = secondsBetween(signupAt, firstFlaggedAt);
					if (seconds !== undefined) row.secondsToFirstFlagged = seconds;
				}
				perUser.push(row);
			}
			// Sort by signup INSTANT (contract says "sorted by signupAt ascending"); a raw
			// string sort would misorder rows whose timestamps carry different offsets.
			perUser.sort(
				(a, b) => (epochMs(a.signupAt) ?? 0) - (epochMs(b.signupAt) ?? 0),
			);

			const verifyDurations = perUser
				.map((user) => user.secondsToFirstVerify)
				.filter((seconds): seconds is number => seconds !== undefined && seconds >= 0);
			const confirmedDurations = perUser
				.map((user) => user.secondsToFirstConfirmedTx)
				.filter((seconds): seconds is number => seconds !== undefined && seconds >= 0);
			const flaggedDurations = perUser
				.map((user) => user.secondsToFirstFlagged)
				.filter((seconds): seconds is number => seconds !== undefined && seconds >= 0);

			// Funds secured — over ALL verdicts (shared-key included; no email join needed).
			const totals = emptyFundsBucket();
			const byDayMap = new Map<string, FundsBucket>();
			for (const verdict of verdicts) {
				const hadAmount = verdict.intendedEffect.amountUsd !== undefined;
				const usd = verdict.intendedEffect.amountUsd ?? 0;
				addToFundsBucket(totals, verdict.decision, usd, hadAmount);

				const day = utcDay(verdict.decidedAt);
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
				betaClicks,
				waitlist,
				onboarding: {
					users: signupByEmail.size,
					activated: perUser.filter((user) => user.firstVerifyAt !== undefined).length,
					confirmed: perUser.filter((user) => user.firstConfirmedTxAt !== undefined).length,
					flagged: perUser.filter((user) => user.firstFlaggedAt !== undefined).length,
					medianSecondsToFirstVerify: median(verifyDurations),
					averageSecondsToFirstVerify: average(verifyDurations),
					medianSecondsToFirstConfirmedTx: median(confirmedDurations),
					medianSecondsToFirstFlagged: median(flaggedDurations),
					averageSecondsToFirstFlagged: average(flaggedDurations),
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
