import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";

import { createInMemoryCredentialStore } from "../credential/credentialStore";
import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import type { DecidedInput, VerdictStore } from "../verdict/verdictStoreTypes";
import type { BetaClickMetricsReader } from "./metricsContracts";
import {
	createMetricsService as createBaseMetricsService,
	type MetricsServiceDependencies,
} from "./metricsService";

const FIXED_NOW = "2026-07-26T12:00:00.000Z";

const EMPTY_BETA_CLICK_METRICS: BetaClickMetricsReader = {
	readAllTime: async () => ({
		period: "all_time",
		total: 0,
		bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
	}),
};

function createMetricsService(
	deps: Omit<MetricsServiceDependencies, "betaClickMetricsReader"> & {
		betaClickMetricsReader?: BetaClickMetricsReader;
	},
) {
	return createBaseMetricsService({
		...deps,
		betaClickMetricsReader: deps.betaClickMetricsReader ?? EMPTY_BETA_CLICK_METRICS,
	});
}

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
	it("loads verdicts before credentials so lazy Pg schema setup stays serial", async () => {
		const verdictStore = createInMemoryVerdictStore();
		const credentialStore = createInMemoryCredentialStore();
		const events: string[] = [];
		let releaseVerdicts: () => void;
		const service = createMetricsService({
			verdictStore: {
				...verdictStore,
				list: async () => {
					events.push("verdicts-start");
					await new Promise<void>((resolve) => { releaseVerdicts = resolve; });
					events.push("verdicts-end");
					return [];
				},
			},
			credentialStore: {
				...credentialStore,
				listIssued: async () => {
					events.push("credentials");
					return [];
				},
			},
		});

		const pending = service.computeMetrics();
		await Promise.resolve();
		expect(events).toEqual(["verdicts-start"]);
		releaseVerdicts!();
		await pending;
		expect(events).toEqual(["verdicts-start", "verdicts-end", "credentials"]);
	});

	it("propagates beta click read failures to the dashboard server", async () => {
		const failure = new Error("beta click query failed");
		const service = createMetricsService({
			verdictStore: createInMemoryVerdictStore(),
			credentialStore: createInMemoryCredentialStore(),
			betaClickMetricsReader: { readAllTime: async () => Promise.reject(failure) },
		});

		await expect(service.computeMetrics()).rejects.toBe(failure);
	});

	it("empty stores → zeros, nulls, empty arrays", async () => {
		const service = createMetricsService({
			verdictStore: createInMemoryVerdictStore(),
			credentialStore: createInMemoryCredentialStore(),
			isoNow: () => FIXED_NOW,
		});

		const metrics = await service.computeMetrics();

		expect(metrics.generatedAt).toBe(FIXED_NOW);
		expect(metrics.betaClicks).toEqual({
			period: "all_time",
			total: 0,
			bySource: { nav: 0, hero: 0, closing: 0, unknown: 0 },
		});
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
				flaggedWithoutAmount: 0,
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
			flaggedWithoutAmount: 0,
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
			flaggedWithoutAmount: 0,
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
				flaggedWithoutAmount: 0,
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
				// The review verdict carried no amount — unknown value, not zero.
				flaggedWithoutAmount: 1,
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
			flaggedWithoutAmount: 1,
		});
		expect(metrics.fundsSecured.totals.possibleFundsLostUsd).toBe(
			metrics.fundsSecured.totals.reviewUsd + metrics.fundsSecured.totals.denyUsd,
		);
	});
	// FINDING 3 — /verify accepts any Date.parse-able requestedAt, so offset timestamps reach
	// the store. Ordering them as raw strings compares wall clocks, not instants.
	it("orders 'first' by INSTANT, not by raw string (offset timestamps)", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await credentialStore.issue({
			email: "alice@example.com",
			tokenHash: "hash-alice",
			createdAt: "2026-07-26T07:00:00.000Z",
		});
		// A is 08:00Z written as +02:00 — genuinely first, but sorts LATER as a string.
		await putVerdict(verdictStore, {
			correlationId: "corr-offset-a",
			decidedAt: "2026-07-26T10:00:00.000+02:00",
			authenticatedEmail: "alice@example.com",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-utc-b",
			decidedAt: "2026-07-26T09:00:00.000Z",
			authenticatedEmail: "alice@example.com",
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.perUser[0].firstVerifyAt).toBe("2026-07-26T10:00:00.000+02:00");
		expect(metrics.onboarding.perUser[0].secondsToFirstVerify).toBe(3600);
	});

	it("buckets byDay on the UTC day, normalizing offsets", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		// 2026-07-27T00:30+02:00 IS 2026-07-26T22:30Z — the 26th in UTC.
		await putVerdict(verdictStore, {
			correlationId: "corr-late",
			decidedAt: "2026-07-27T00:30:00.000+02:00",
			decision: "deny",
			intendedEffect: transferEffect(40),
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.fundsSecured.byDay.map((bucket) => bucket.day)).toEqual(["2026-07-26"]);
		expect(metrics.fundsSecured.byDay[0].denyUsd).toBe(40);
	});

	// FINDING 4 — a blocked transfer denominated in SOL carries no amountUsd, so the money
	// figure is a LOWER BOUND. The count makes that legible instead of silently zero.
	it("counts flagged verdicts carrying no USD amount so the figure reads as a lower bound", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await putVerdict(verdictStore, {
			correlationId: "corr-known",
			decidedAt: "2026-07-26T10:00:00.000Z",
			decision: "deny",
			intendedEffect: transferEffect(30),
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-unknown",
			decidedAt: "2026-07-26T11:00:00.000Z",
			decision: "deny",
			intendedEffect: transferEffect(), // SOL-denominated block: value unknown
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-allow-noamount",
			decidedAt: "2026-07-26T12:00:00.000Z",
			decision: "allow",
			intendedEffect: transferEffect(), // allow → not flagged, must NOT count
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.fundsSecured.totals.possibleFundsLostUsd).toBe(30);
		expect(metrics.fundsSecured.totals.flaggedWithoutAmount).toBe(1);
	});

	// FINDING 6 — reviewUsd was never asserted nonzero anywhere, so half of
	// possibleFundsLostUsd = reviewUsd + denyUsd went unexercised.
	it("sums review amounts into possibleFundsLostUsd alongside denies", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await putVerdict(verdictStore, {
			correlationId: "corr-review",
			decidedAt: "2026-07-26T10:00:00.000Z",
			decision: "review",
			intendedEffect: transferEffect(70),
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-deny",
			decidedAt: "2026-07-26T11:00:00.000Z",
			decision: "deny",
			intendedEffect: transferEffect(30),
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-allow",
			decidedAt: "2026-07-26T12:00:00.000Z",
			decision: "allow",
			intendedEffect: transferEffect(500),
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.fundsSecured.totals.reviewUsd).toBe(70);
		expect(metrics.fundsSecured.totals.denyUsd).toBe(30);
		expect(metrics.fundsSecured.totals.possibleFundsLostUsd).toBe(100);
		expect(metrics.fundsSecured.totals.allowUsd).toBe(500);
		expect(metrics.fundsSecured.totals.totalUsd).toBe(600);
	});

	it("median over an EVEN count averages the two middle values", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		// Four users at 100s / 200s / 300s / 400s → median 250, average 250.
		const offsets = [100, 200, 300, 400];
		for (const [index, offset] of offsets.entries()) {
			const email = `user${index}@example.com`;
			await credentialStore.issue({
				email,
				tokenHash: `hash-${index}`,
				createdAt: "2026-07-26T10:00:00.000Z",
			});
			await putVerdict(verdictStore, {
				correlationId: `corr-${index}`,
				decidedAt: new Date(Date.parse("2026-07-26T10:00:00.000Z") + offset * 1000).toISOString(),
				authenticatedEmail: email,
			});
		}

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.medianSecondsToFirstVerify).toBe(250);
		expect(metrics.onboarding.averageSecondsToFirstVerify).toBe(250);
	});

	it("joins signup to verdicts for a mixed-case email (normalized on both sides)", async () => {
		const credentialStore = createInMemoryCredentialStore();
		const verdictStore = createInMemoryVerdictStore();
		await credentialStore.issue({
			email: "  MiXeD@Example.COM ",
			tokenHash: "hash-mixed",
			createdAt: "2026-07-26T10:00:00.000Z",
		});
		await putVerdict(verdictStore, {
			correlationId: "corr-mixed",
			decidedAt: "2026-07-26T10:05:00.000Z",
			authenticatedEmail: "mixed@example.com",
		});

		const service = createMetricsService({ verdictStore, credentialStore, isoNow: () => FIXED_NOW });
		const metrics = await service.computeMetrics();

		expect(metrics.onboarding.users).toBe(1);
		expect(metrics.onboarding.activated).toBe(1);
		expect(metrics.onboarding.perUser[0].email).toBe("mixed@example.com");
		expect(metrics.onboarding.perUser[0].secondsToFirstVerify).toBe(300);
	});
});
