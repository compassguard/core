/**
 * LIVE reconstruction-fields suite — the REAL mandate judge (an actual LLM via the codex
 * shim, scripts/codex-judge-shim.mjs) through the REAL verify service into the REAL
 * durable Pg store implementation (in-process PGlite).
 *
 * What this proves beyond the unit/contract suites (which use fake providerFns): with a
 * live model producing the judge output, every reconstruction field lands in the Postgres
 * row with honest values — statedPurpose, mandateSnapshot, policy identity, the pre-judge
 * deterministicDecision, and the judge provenance (model/clamped/confidence/reasonCodes).
 *
 * RUN (shim first, then the suite):
 *   node scripts/codex-judge-shim.mjs &                       # port 8787, codex login
 *   COMPASS_JUDGE_SHIM_URL=http://127.0.0.1:8787 \
 *   npx vitest --config vitest.back.config.ts --run hosted/verify/__live_reconstruction.test.ts
 *
 * SKIPS when COMPASS_JUDGE_SHIM_URL is unset (safe for normal CI). Codex round-trips run
 * 6–90s (see docs/testing/2026-07-26-verify-judge-live-llm-results.md), hence the long
 * per-test timeouts. Consumer ChatGPT terms: local test only, synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import { createInMemoryMandateStore } from "../mandate/mandateStore";
import { createPgVerdictStore, type SqlExecutor } from "../verdict/verdictStorePg";
import { createVerifyJudge } from "./verifyJudge";
import { createVerifyService } from "./verifyService";
import type { LlmJudgeConfig } from "@shared/llmDecisionContracts";
import type { Mandate } from "@shared/mandateContracts";

const SHIM_URL = process.env.COMPASS_JUDGE_SHIM_URL;
const LIVE = Boolean(SHIM_URL);
const JUDGE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;

/** Same PGlite→SqlExecutor bridge as verdictStorePg.test.ts. */
function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

const MANDATE: Mandate = {
	ownerId: "live-recon@example.com",
	mandateText:
		"Pay monthly rent of up to $50 to my landlord at RcpT111. No other payments, no trading.",
	allowedRecipients: ["RcpT111"],
	maxAmountUsd: 50,
	updatedAt: "2026-07-26T00:00:00.000Z",
};

// The codex account default is gpt-5.5; config.model is what the shim receives AND what
// the judge persists as judgeModel, so this is the honest live model identity.
const LIVE_CONFIG: LlmJudgeConfig = {
	enabled: true,
	provider: "opencode-go",
	model: "gpt-5.5",
	baseUrl: SHIM_URL,
	timeoutMs: JUDGE_TIMEOUT_MS,
};

async function makeLiveService(config: LlmJudgeConfig) {
	const db = new PGlite();
	const sql = executor(db);
	const verdictStore = createPgVerdictStore({ sql });
	const mandateStore = createInMemoryMandateStore();
	await mandateStore.put(MANDATE);
	const service = createVerifyService({
		verdictStore,
		mandateStore,
		verifyJudge: createVerifyJudge({ config }),
	});
	return { service, verdictStore, sql };
}

describe.runIf(LIVE)("live reconstruction fields (real LLM via codex shim + Pg store)", () => {
	it(
		"persists full judge provenance on a live-judged mandate violation",
		async () => {
			const { service, verdictStore, sql } = await makeLiveService(LIVE_CONFIG);

			// Deterministic floor is ALLOW (known recipient, tiny amount); the purpose
			// violates the mandate (trading, not rent) — the live model should tighten.
			const res = await service.verifyAction(
				{
					toolName: "transfer_sol",
					intent: { kind: "transfer", statedPurpose: "buy the trending meme coin fast" },
					arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
				},
				{ authenticatedEmail: MANDATE.ownerId },
			);

			// MUST (contract, not model behavior): the judge ran on stated intent.
			expect(res.intentSource).toBe("self_report");

			const record = await verdictStore.getByCorrelationId(res.correlationId);
			// Decision-time inputs, verbatim.
			expect(record?.statedPurpose).toBe("buy the trending meme coin fast");
			expect(record?.mandateSnapshot).toEqual(MANDATE);
			expect(record?.policyId).toBe("default-conservative");
			expect(record?.policyVersion).toBe("0.1.0");
			expect(record?.evaluatedRules?.length).toBeGreaterThan(0);
			expect(record?.deterministicDecision).toBe("ALLOW");
			// Judge provenance from the LIVE call.
			expect(record?.judgeModel).toBe("gpt-5.5");
			expect(["ALLOW", "DENY", "REQUIRE_HUMAN_APPROVAL", "REQUIRE_ADDITIONAL_CONTEXT"]).toContain(
				record?.judgeRawDecision,
			);
			expect(typeof record?.judgeClamped).toBe("boolean");
			expect(record?.judgeConfidence).toBeGreaterThanOrEqual(0);
			expect(record?.judgeConfidence).toBeLessThanOrEqual(1);
			expect(Array.isArray(record?.judgeReasonCodes)).toBe(true);
			// Attribution invariant: the merged reasons END with the judge's contribution.
			expect(record?.reasons.slice(-(record?.judgeReasonCodes?.length ?? 0))).toEqual(
				record?.judgeReasonCodes,
			);

			// Substrate check: the raw Postgres row carries the new columns (not just the
			// mapped record) — reconstruction survives at the SQL altitude.
			const rows = await sql(
				`SELECT stated_purpose, mandate_snapshot, policy_id, deterministic_decision,
				        judge_model, judge_confidence FROM verdicts WHERE correlation_id = $1`,
				[res.correlationId],
			);
			expect(rows[0]?.stated_purpose).toBe("buy the trending meme coin fast");
			expect(rows[0]?.policy_id).toBe("default-conservative");
			expect(rows[0]?.deterministic_decision).toBe("ALLOW");
			expect(rows[0]?.judge_model).toBe("gpt-5.5");

			// eslint-disable-next-line no-console
			console.log("[live-judged]", JSON.stringify(record, null, 2));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"persists policy identity + statedPurpose but no judge fields when no mandate matches",
		async () => {
			const { service, verdictStore } = await makeLiveService(LIVE_CONFIG);

			const res = await service.verifyAction(
				{
					toolName: "transfer_sol",
					intent: { kind: "transfer", statedPurpose: "pay rent" },
					arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
				},
				{ authenticatedEmail: "stranger@example.com" }, // no registered mandate
			);

			expect(res.intentSource).toBe("none");
			const record = await verdictStore.getByCorrelationId(res.correlationId);
			expect(record?.statedPurpose).toBe("pay rent");
			expect(record?.policyId).toBe("default-conservative");
			expect(record?.deterministicDecision).toBe("ALLOW");
			expect(record?.mandateSnapshot).toBeUndefined();
			expect(record?.judgeModel).toBeUndefined();
			expect(record?.judgeConfidence).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"snapshots the mandate on judge_unavailable (1ms timeout aborts the live call)",
		async () => {
			const { service, verdictStore } = await makeLiveService({
				...LIVE_CONFIG,
				timeoutMs: 1,
			});

			const res = await service.verifyAction(
				{
					toolName: "transfer_sol",
					intent: { kind: "transfer", statedPurpose: "pay rent to my landlord" },
					arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
				},
				{ authenticatedEmail: MANDATE.ownerId },
			);

			// Fail-honest: deterministic verdict stands, judge_unavailable appended.
			expect(res.intentSource).toBe("none");
			expect(res.reasons).toContain("judge_unavailable");

			const record = await verdictStore.getByCorrelationId(res.correlationId);
			// The mandate the judge SHOULD have judged against is still reconstructable.
			expect(record?.mandateSnapshot).toEqual(MANDATE);
			expect(record?.statedPurpose).toBe("pay rent to my landlord");
			expect(record?.judgeModel).toBeUndefined();
			expect(record?.judgeRawDecision).toBeUndefined();
			expect(record?.judgeClamped).toBeUndefined();
			expect(record?.judgeConfidence).toBeUndefined();
			expect(record?.judgeReasonCodes).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);
});
