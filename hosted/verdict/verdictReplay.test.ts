/**
 * Reconstruction proof — a stored verdict row is REPLAYED through the real engines and
 * must reproduce itself. This is the executable definition of "every verdict
 * reconstructable": not that the fields round-trip (the contract suite covers that), but
 * that the row alone carries enough to RE-DERIVE the verdict.
 *
 * Deterministic leg: row.toolContext + row.policySnapshot + row.toolClassification feed
 *   evaluateAction, which must reproduce row.deterministicDecision, the deterministic reasons
 *   prefix, and row.evaluatedRules. BOTH compiled-in inputs come from the ROW, never from the
 *   current build: policyId/policyVersion only NAME the policy (a threshold can be edited
 *   without a version bump, so identity cannot detect drift), and classifyToolCall() reads
 *   module-level tool sets (so re-deriving from toolName reclassifies past verdicts whenever
 *   those sets change).
 * Judge leg: the LLM call itself is not re-run (it is a recorded actor, not a replayable
 *   function) — but its recorded output (judgeRawDecision/confidence/reasonCodes/rationale)
 *   re-enters the REAL clamp, which must reproduce the stored post-judge decision,
 *   judgeClamped, the merged reasons, and the humanExplanation verbatim.
 *
 * Runs the full path through the durable Pg implementation (PGlite), not the in-memory map.
 */
import { describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import {
	COMPASS_DECISIONS,
	TOOL_RISK_CLASSES,
	type CompassDecision,
} from "@shared/executionGatewayContracts";
import type { CompassPolicy } from "@shared/policyContracts";

import { createVerifyService } from "../verify/verifyService";
import { createInMemoryMandateStore } from "../mandate/mandateStore";
import { loadDefaultPolicy } from "../policy/loadPolicy";
import { createPgVerdictStore, type SqlExecutor } from "./verdictStorePg";
import { replayVerdict, type ReplayResult } from "./verdictReplay";
import type { VerdictRecord } from "./verdictStoreTypes";
import type { VerifyJudgeResult } from "../verify/verifyJudge";

function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

/** Narrow a ReplayResult to its success case, failing loudly with the refusal reason. */
function expectReplayed(result: ReplayResult) {
	if (!result.ok) throw new Error(`replay refused: ${result.reason}`);
	return result;
}

/** Full pipeline: real service writes to Pg → read the row back → replay → compare. */
async function decideAndReplay(judgeResult: VerifyJudgeResult, statedPurpose?: string) {
	const verdictStore = createPgVerdictStore({ sql: executor(new PGlite()) });
	const mandateStore = createInMemoryMandateStore();
	await mandateStore.put({
		ownerId: "replay@example.com",
		mandateText: "Only pay approved vendors.",
		updatedAt: "2026-07-26T00:00:00.000Z",
	});
	const service = createVerifyService({
		verdictStore,
		mandateStore,
		verifyJudge: async () => judgeResult,
	});

	const res = await service.verifyAction(
		{
			toolName: "transfer_sol",
			intent: {
				kind: "transfer",
				...(statedPurpose !== undefined ? { statedPurpose } : {}),
			},
			arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
		},
		{ authenticatedEmail: "replay@example.com" },
	);
	const record = await verdictStore.getByCorrelationId(res.correlationId);
	if (!record) throw new Error("verdict row missing");
	return { res, record, replayed: expectReplayed(replayVerdict(record)) };
}

describe("verdict replay from the stored row (reconstruction proof)", () => {
	it("reproduces a deterministic-only verdict exactly", async () => {
		const { record, replayed } = await decideAndReplay({ ran: false }, undefined);

		expect(replayed.deterministicDecision).toBe(record.deterministicDecision);
		expect(replayed.evaluatedRules).toEqual(record.evaluatedRules);
		expect(replayed.decision).toBe(record.decision);
		expect(replayed.reasons).toEqual(record.reasons);
		expect(replayed.humanExplanation).toBe(record.humanExplanation);
	});

	it("reproduces a judge-tightened verdict exactly, including the explanation", async () => {
		const { record, replayed } = await decideAndReplay(
			{
				ran: true,
				decision: "DENY" as CompassDecision,
				clamped: true,
				reasonCodes: ["off_mandate_recipient"],
				rationale: "Recipient is not part of the owner's mandate.",
				model: "test-model",
				confidence: 0.9,
				rawDecision: "DENY",
			},
			"pay vendor Acme invoice #42",
		);

		expect(record.decision).toBe("deny"); // sanity: the judge did tighten
		expect(replayed.decision).toBe(record.decision);
		expect(replayed.deterministicDecision).toBe(record.deterministicDecision);
		expect(replayed.judgeClamped).toBe(record.judgeClamped);
		expect(replayed.reasons).toEqual(record.reasons);
		expect(replayed.humanExplanation).toBe(record.humanExplanation);
	});

	it("reproduces a clamp-discarded loosening attempt: replay shows the overrule", async () => {
		// Judge tries REQUIRE→ALLOW on an over-cap transfer; service stored the clamped
		// result. Replay must reproduce the SAME final decision from the recorded raw
		// attempt — proving the row distinguishes "overruled loosen" from "accepted".
		const verdictStore = createPgVerdictStore({ sql: executor(new PGlite()) });
		const mandateStore = createInMemoryMandateStore();
		await mandateStore.put({
			ownerId: "replay@example.com",
			mandateText: "Anything goes.",
			updatedAt: "2026-07-26T00:00:00.000Z",
		});
		const service = createVerifyService({
			verdictStore,
			mandateStore,
			// Clamp-consistent fixture: the real judge's `decision` comes FROM the clamp, so a
			// discarded ALLOW loosen must carry the deterministic floor as its post-clamp
			// decision. (The replay harness caught an earlier fixture that violated this —
			// an inconsistent pairing is detectable as a non-reproducing row.)
			verifyJudge: async () => ({
				ran: true,
				decision: "REQUIRE_ADDITIONAL_CONTEXT" as CompassDecision, // post-clamp: floor held
				clamped: true,
				reasonCodes: ["looks_fine"],
				rationale: "Seems consistent with the mandate.",
				model: "test-model",
				confidence: 0.99,
				rawDecision: "ALLOW", // what the model actually said
			}),
		});
		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "big payment" },
				// Over-cap + unknown recipient → deterministic REQUIRE floor.
				arguments: { recipient: "Stranger", amountUsd: 999 },
			},
			{ authenticatedEmail: "replay@example.com" },
		);
		const record = await verdictStore.getByCorrelationId(res.correlationId);
		if (!record) throw new Error("verdict row missing");

		expect(record.judgeRawDecision).toBe("ALLOW");
		expect(record.decision).toBe("review"); // loosen was discarded

		const replayed = expectReplayed(replayVerdict(record));
		expect(replayed.decision).toBe(record.decision);
		expect(replayed.judgeClamped).toBe(true);
		expect(replayed.reasons).toEqual(record.reasons);
		expect(replayed.humanExplanation).toBe(record.humanExplanation);
	});

	it("replays against the row's OWN policy, not the current build's", async () => {
		// The regression this guards: a threshold edited in defaultPolicy.ts WITHOUT a version
		// bump. Identity still matches, so an identity-only guard waves it through and replay
		// silently re-derives a decision that never happened (a $5 transfer decided ALLOW
		// replaying as REQUIRE_HUMAN_APPROVAL under a lowered cap). Reading the rulebook from
		// the row makes the current build's contents irrelevant.
		const { record, replayed } = await decideAndReplay({ ran: false }, undefined);
		expect(record.deterministicDecision).toBe("ALLOW"); // sanity: $5 is under the cap
		expect(replayed.deterministicDecision).toBe("ALLOW");

		const live = loadDefaultPolicy();
		const editedRulebook: CompassPolicy = {
			...live,
			// Same policy_id, same version string — only the number moved.
			transfers: { ...live.transfers, max_usd_without_approval: 3 },
		};
		const rowUnderEditedBuild: VerdictRecord = {
			...record,
			policySnapshot: editedRulebook,
		};
		// Proof the edit is decision-changing: replayed through the edited rulebook, the
		// same row yields the other outcome.
		expect(expectReplayed(replayVerdict(rowUnderEditedBuild)).deterministicDecision).toBe(
			"REQUIRE_HUMAN_APPROVAL",
		);
		// ...and the untouched row still reproduces itself, because it carries its own.
		expect(expectReplayed(replayVerdict(record)).deterministicDecision).toBe(record.deterministicDecision);
		expect(expectReplayed(replayVerdict(record)).evaluatedRules).toEqual(record.evaluatedRules);
	});

	it("replays against the row's OWN tool classification, not the current build's", async () => {
		// The regression this guards: dropping a tool from SENSITIVE_EXECUTION_TOOLS (or
		// changing its defaultDecision) in back/guardrail/execution/executionGateway.ts. Nothing
		// about the row changes, and toolName still matches — so re-deriving the classification
		// silently reclassifies every past verdict for that tool. Second compiled-in input to a
		// decision; same drift class as the policy snapshot. Found by external review, 2026-08-05.
		const { record, replayed } = await decideAndReplay({ ran: false }, undefined);
		expect(record.toolClassification?.toolName).toBe("transfer_sol");
		expect(replayed.deterministicDecision).toBe(record.deterministicDecision);

		const reclassified: VerdictRecord = {
			...record,
			toolClassification: {
				...record.toolClassification!,
				// Exactly what classifyToolCall returns for a mutating tool that is NOT in
				// SENSITIVE_EXECUTION_TOOLS (executionGateway.ts:90-99).
				riskClass: TOOL_RISK_CLASSES.BLOCKED_UNKNOWN,
				defaultDecision: COMPASS_DECISIONS.DENY,
				auditRequired: true,
				reasonCodes: ["UNKNOWN_MUTATING_TOOL"],
			},
		};
		// Proof the classification is decision-bearing: same row, different classification,
		// different outcome.
		expect(expectReplayed(replayVerdict(reclassified)).deterministicDecision).not.toBe(
			record.deterministicDecision,
		);
		// ...and the untouched row still reproduces itself, because it carries its own.
		expect(expectReplayed(replayVerdict(record)).deterministicDecision).toBe(record.deterministicDecision);
	});

	it("refuses to replay a row that predates the tool-classification snapshot", async () => {
		const { record } = await decideAndReplay({ ran: false }, undefined);
		const legacy: VerdictRecord = { ...record };
		delete legacy.toolClassification;
		const refused = replayVerdict(legacy);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.missingField).toBe("toolClassification");
		expect(refused.reason).toMatch(/tool-classification snapshot/);
	});

	it("reproduces a JUDGE-UNAVAILABLE verdict, including the degraded-check reason", async () => {
		// The service appends `judge_unavailable` when the judge was called and did not answer.
		// Nothing records that directly — it is derived from "mandate snapshot present, no judge
		// output". Before this was handled, replay silently dropped the reason and claimed a
		// cleaner decision than actually happened. The pre-existing deterministic-only test
		// missed it because it passes NO statedPurpose, so the judge gate is never entered.
		// Surfaced by comparing the FULL replayed surface rather than just the decisions
		// (external review, gpt-5.6, 2026-08-05).
		const { record, replayed } = await decideAndReplay({ ran: false }, "pay the landlord");

		expect(record.mandateSnapshot).toBeDefined();
		expect(record.judgeRawDecision).toBeUndefined();
		expect(record.judgeStatus).toBe("unavailable"); // RECORDED, not inferred
		expect(record.reasons).toContain("judge_unavailable");
		expect(replayed.reasons).toEqual(record.reasons);
		expect(replayed.humanExplanation).toBe(record.humanExplanation);
		expect(replayed.decision).toBe(record.decision);
	});

	it("trusts a RECORDED judgeStatus over the mandate-snapshot inference", async () => {
		// The old inference read "mandate snapshot present, no judge output" as unavailable.
		// A type-valid row can snapshot a found mandate WITHOUT attempting a judge, and the
		// inference would invent a judge_unavailable reason that never happened. The recorded
		// status settles it. Found by external review (gpt-5.6), 2026-08-06.
		const { record } = await decideAndReplay({ ran: false }, "pay the landlord");
		const neverAttempted: VerdictRecord = {
			...record,
			judgeStatus: "not_attempted",
			reasons: record.reasons.filter((r) => r !== "judge_unavailable"),
		};
		const replayed = expectReplayed(replayVerdict(neverAttempted));
		expect(replayed.reasons).not.toContain("judge_unavailable");
		expect(replayed.reasons).toEqual(neverAttempted.reasons);
	});

	it("reconstructs intentSource so a row disagreeing with its judge fields is caught", async () => {
		const { record, replayed } = await decideAndReplay({ ran: false }, undefined);
		expect(replayed.intentSource).toBe("none");
		expect(record.intentSource).toBe("none");
	});

	it("refuses a judged row that lacks its pre-judge deterministic floor", async () => {
		// The clamp is defined RELATIVE to the deterministic decision. Clamping against
		// undefined would invent a verdict the original clamp never computed — and report
		// success. The service always writes both; the store's type permits one without the
		// other, so replay must not trust that. Found by external review (gpt-5.6), 2026-08-05.
		const { record } = await decideAndReplay({ ran: false }, undefined);
		const judgedWithoutFloor: VerdictRecord = { ...record, judgeRawDecision: "ALLOW" };
		delete judgedWithoutFloor.deterministicDecision;
		const refused = replayVerdict(judgedWithoutFloor);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.missingField).toBe("deterministicDecision");
	});

	it("refuses to replay a row that predates the policy snapshot", async () => {
		const { record } = await decideAndReplay({ ran: false }, undefined);
		const legacy: VerdictRecord = { ...record };
		delete legacy.policySnapshot;
		const refused = replayVerdict(legacy);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.missingField).toBe("policySnapshot");
		expect(refused.reason).toMatch(/policy snapshot/);
	});
});
