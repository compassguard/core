import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";

import { createInMemoryCredentialStore } from "../credential/credentialStore";
import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import type { DecidedInput, VerdictStore } from "../verdict/verdictStoreTypes";
import { createMetricsService } from "./metricsService";

const FIXED_NOW = "2026-07-26T12:00:00.000Z";

function transferEffect(amountUsd?: number): IntendedEffect {
	return amountUsd === undefined
		? { actionKind: "transfer" }
		: { actionKind: "transfer", amountUsd };
}

async function putVerdict(
	store: VerdictStore,
	overrides: Partial<DecidedInput> & { correlationId: string; decidedAt: string },
): Promise<void> {
	await store.putDecided({
		decision: "allow",
		reasons: [],
		humanExplanation: "test verdict",
		intendedEffect: transferEffect(),
		...overrides,
	});
}

describe("createMetricsService", () => {
	it("empty stores → zeros, nulls, empty arrays", async () => {
		const service = createMetricsService({
			verdictStore: createInMemoryVerdictStore(),
			credentialStore: createInMemoryCredentialStore(),
			isoNow: () => FIXED_NOW,
		});

		const metrics = await service.computeMetrics();

		expect(metrics.generatedAt).toBe(FIXED_NOW);
		expect(metrics.onboarding).toEqual({
			users: 0,
			activated: 0,
			confirmed: 0,
			flagged: 0,
			medianSecondsToFirstVerify: null,
			averageSecondsToFirstVerify: null,
			medianSecondsToFirstConfirmedTx: null,
			medianSecondsToFirstFlagged: null,
			averageSecondsToFirstFlagged: null,
			perUser: [],
		});
		expect(metrics.fundsSecured).toEqual({
			totals: {
				verdicts: 0,
				withAmountUsd: 0,
				totalUsd: 0,
				allowUsd: 0,
				reviewUsd: 0,
				denyUsd: 0,
				possibleFundsLostUsd: 0,
			},
			byDay: [],
		});
	});

	it("one user, signup 10:00, verdict decided 10:05 with amountUsd 50 allow → activated 1, secondsToFirstVerify 300, median/average 300, funds bucket correct", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await credentialStore.issue({
			email: "alice@example.com",
			tokenHash: "hash-alice",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-1",
			decidedAt: "2026-07-26T10:05:00.000Z",
			authenticatedEmail: "alice@example.com",
			decision: "allow",
			intendedEffect: transferEffect(50),
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.users).toBe(1);
		expect(metrics.onboarding.activated).toBe(1);
		expect(metrics.onboarding.flagged).toBe(0);
		expect(metrics.onboarding.perUser).toEqual([
			{
				email: "alice@example.com",
				signupAt: "2026-07-26T10:00:00.000Z",
				firstVerifyAt: "2026-07-26T10:05:00.000Z",
				secondsToFirstVerify: 300,
			},
		]);
		expect(metrics.onboarding.perUser[0].firstFlaggedAt).toBeUndefined();
		expect(metrics.onboarding.medianSecondsToFirstVerify).toBe(300);
		expect(metrics.onboarding.averageSecondsToFirstVerify).toBe(300);
		expect(metrics.onboarding.medianSecondsToFirstFlagged).toBeNull();
		expect(metrics.fundsSecured.totals).toEqual({
			verdicts: 1,
			withAmountUsd: 1,
			totalUsd: 50,
			allowUsd: 50,
			reviewUsd: 0,
			denyUsd: 0,
			possibleFundsLostUsd: 0,
		});
	});

	it("two verdicts for one user (allow at +300s, deny at +600s) → firstVerifyAt is the earlier one; firstFlaggedAt is the deny", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await credentialStore.issue({
			email: "alice@example.com",
			tokenHash: "hash-alice",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-later",
			decidedAt: "2026-07-26T10:10:00.000Z",
			authenticatedEmail: "alice@example.com",
			decision: "deny",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-earlier",
			decidedAt: "2026-07-26T10:05:00.000Z",
			authenticatedEmail: "alice@example.com",
			decision: "allow",
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.perUser).toHaveLength(1);
		expect(metrics.onboarding.perUser[0].firstVerifyAt).toBe("2026-07-26T10:05:00.000Z");
		expect(metrics.onboarding.perUser[0].secondsToFirstVerify).toBe(300);
		// The allow verdict (first overall) is NOT flagged; the deny (second) is the first flagged one.
		expect(metrics.onboarding.perUser[0].firstFlaggedAt).toBe("2026-07-26T10:10:00.000Z");
		expect(metrics.onboarding.perUser[0].secondsToFirstFlagged).toBe(600);
	});

	it("shared-key verdict (no authenticatedEmail) → counted in fundsSecured, absent from onboarding", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await putVerdict(verdictStore, {
			correlationId: "corr-shared",
			decidedAt: "2026-07-26T10:05:00.000Z",
			decision: "deny",
			intendedEffect: transferEffect(20),
			// no authenticatedEmail — the shared-key path
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.users).toBe(0);
		expect(metrics.onboarding.perUser).toEqual([]);
		expect(metrics.fundsSecured.totals).toEqual({
			verdicts: 1,
			withAmountUsd: 1,
			totalUsd: 20,
			allowUsd: 0,
			reviewUsd: 0,
			denyUsd: 20,
			possibleFundsLostUsd: 20,
		});
	});

	it("negative duration user (decidedAt before signupAt) → perUser keeps the negative value, aggregates exclude it", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await credentialStore.issue({
			email: "alice@example.com",
			tokenHash: "hash-alice",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		await credentialStore.issue({
			email: "bob@example.com",
			tokenHash: "hash-bob",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		// alice's verdict is decided BEFORE her signup (caller-supplied requestedAt) → negative.
		await putVerdict(verdictStore, {
			correlationId: "corr-alice",
			decidedAt: "2026-07-26T09:00:00.000Z",
			authenticatedEmail: "alice@example.com",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-bob",
			decidedAt: "2026-07-26T10:10:00.000Z",
			authenticatedEmail: "bob@example.com",
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		const alice = metrics.onboarding.perUser.find((user) => user.email === "alice@example.com");
		expect(alice?.secondsToFirstVerify).toBe(-3600);
		// Only bob's (positive) 600s duration feeds the aggregates.
		expect(metrics.onboarding.medianSecondsToFirstVerify).toBe(600);
		expect(metrics.onboarding.averageSecondsToFirstVerify).toBe(600);
	});

	it("confirmed verdict (closeOutcome with txSignature) → confirmed count + secondsToFirstConfirmedTx", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore({ isoNow: () => "2026-07-26T10:20:00.000Z" });
		await credentialStore.issue({
			email: "alice@example.com",
			tokenHash: "hash-alice",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-confirm",
			decidedAt: "2026-07-26T10:05:00.000Z",
			authenticatedEmail: "alice@example.com",
		});
		await verdictStore.closeOutcome("corr-confirm", "match", [], "sig-123");

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.confirmed).toBe(1);
		const alice = metrics.onboarding.perUser.find((user) => user.email === "alice@example.com");
		expect(alice?.firstConfirmedTxAt).toBe("2026-07-26T10:20:00.000Z");
		expect(alice?.secondsToFirstConfirmedTx).toBe(1200);
		expect(metrics.onboarding.medianSecondsToFirstConfirmedTx).toBe(1200);
	});

	it("byDay split across two days with allow/deny amounts → buckets + sums; verdict without amountUsd → verdicts increments, withAmountUsd does not", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await putVerdict(verdictStore, {
			correlationId: "corr-day1-allow",
			decidedAt: "2026-07-26T09:00:00.000Z",
			decision: "allow",
			intendedEffect: transferEffect(10),
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-day1-deny",
			decidedAt: "2026-07-26T15:00:00.000Z",
			decision: "deny",
			intendedEffect: transferEffect(5),
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-day2-review",
			decidedAt: "2026-07-27T09:00:00.000Z",
			decision: "review",
			intendedEffect: transferEffect(), // no amountUsd
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.fundsSecured.byDay).toEqual([
			{
				day: "2026-07-26",
				verdicts: 2,
				withAmountUsd: 2,
				totalUsd: 15,
				allowUsd: 10,
				reviewUsd: 0,
				denyUsd: 5,
				possibleFundsLostUsd: 5,
			},
			{
				day: "2026-07-27",
				verdicts: 1,
				withAmountUsd: 0,
				totalUsd: 0,
				allowUsd: 0,
				reviewUsd: 0,
				denyUsd: 0,
				possibleFundsLostUsd: 0,
			},
		]);
		// possibleFundsLostUsd is always reviewUsd + denyUsd, in every bucket and in totals.
		for (const bucket of metrics.fundsSecured.byDay) {
			expect(bucket.possibleFundsLostUsd).toBe(bucket.reviewUsd + bucket.denyUsd);
		}
		expect(metrics.fundsSecured.totals).toEqual({
			verdicts: 3,
			withAmountUsd: 2,
			totalUsd: 15,
			allowUsd: 10,
			reviewUsd: 0,
			denyUsd: 5,
			possibleFundsLostUsd: 5,
		});
		expect(metrics.fundsSecured.totals.possibleFundsLostUsd).toBe(
			metrics.fundsSecured.totals.reviewUsd + metrics.fundsSecured.totals.denyUsd,
		);
	});
});
