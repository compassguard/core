/**
 * Reconstruction proof — a stored verdict row is REPLAYED through the real engines and
 * must reproduce itself. This is the executable definition of "every verdict
 * reconstructable": not that the fields round-trip (the contract suite covers that), but
 * that the row alone carries enough to RE-DERIVE the verdict.
 *
 * Deterministic leg: row.toolName + row.policyContext + row.policySnapshot →
 *   classifyToolCall + evaluateAction must reproduce row.deterministicDecision, the
 *   deterministic reasons prefix, and row.evaluatedRules. The rulebook comes from the ROW:
 *   policyId/policyVersion NAME the policy, only policySnapshot carries its contents, and
 *   since the default policy is a compiled-in constant editable without a version bump, an
 *   identity check cannot detect drift.
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
	classifyToolCall,
	createActionCandidate,
} from "@back/guardrail/execution/executionGateway";
import type { LlmGuardDecision, LlmGuardOutput } from "@shared/llmDecisionContracts";
import type { CompassDecision } from "@shared/executionGatewayContracts";
import type { CompassPolicy } from "@shared/policyContracts";

import { clampLlmDecision } from "../llm/llmDecisionAdapter";
import {
	collapseToHostedDecision,
	hostedRiskLevelFor,
} from "../evaluate/hostedDecision";
import {
	composeVerdictExplanation,
	mergeJudgeReasons,
} from "../verify/humanExplanation";
import { createVerifyService } from "../verify/verifyService";
import { createInMemoryMandateStore } from "../mandate/mandateStore";
import { evaluateAction } from "../policy/policyEngine";
import { loadDefaultPolicy } from "../policy/loadPolicy";
import { createPgVerdictStore, type SqlExecutor } from "./verdictStorePg";
import type { VerdictRecord } from "./verdictStoreTypes";
import type { VerifyJudgeResult } from "../verify/verifyJudge";

function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

/**
 * Re-derive a verdict from its stored row alone (no request, no live LLM). Returns the
 * reproduced decision surface for comparison against what the row itself recorded.
 */
function replayVerdict(record: VerdictRecord) {
	if (record.toolName === undefined || record.policyContext === undefined) {
		throw new Error("row predates reconstruction fields — not replayable");
	}
	// The rulebook comes from the ROW, not from the current build. Replaying against
	// loadDefaultPolicy() re-reads a compiled-in constant that may have been edited since
	// the decision — and because an edit need not bump `version`, an identity check cannot
	// detect it. The snapshot is the only thing that makes "re-derive from the stored row
	// alone" true rather than "re-derive if nobody touched defaultPolicy.ts".
	if (record.policySnapshot === undefined) {
		throw new Error("row predates the policy snapshot — not replayable");
	}
	const policy = record.policySnapshot;

	const evaluation = evaluateAction({
		candidate: createActionCandidate({
			id: record.correlationId,
			chain: "solana",
			network: "solana",
			toolName: record.toolName,
			actionKind: record.intendedEffect.actionKind,
			createdAt: record.decidedAt,
			params: {},
		}),
		classification: classifyToolCall({ toolName: record.toolName, mutates: true }),
		context: record.policyContext,
		policy,
	});

	let compassDecision = evaluation.decision;
	let reasons = [...evaluation.reasonCodes];
	let judgeClamped: boolean | undefined;
	if (record.judgeRawDecision !== undefined) {
		// Feed the RECORDED model output back through the real clamp.
		const recordedOutput: LlmGuardOutput = {
			decision: record.judgeRawDecision as LlmGuardDecision,
			confidence: record.judgeConfidence ?? 0,
			reasonCodes: record.judgeReasonCodes ?? [],
			rationale: record.judgeRationale ?? "",
		};
		const clamped = clampLlmDecision(
			record.deterministicDecision as CompassDecision,
			recordedOutput,
		);
		compassDecision = clamped.decision;
		judgeClamped = clamped.clamped;
		reasons = mergeJudgeReasons(reasons, recordedOutput.reasonCodes);
	}

	const decision = collapseToHostedDecision(compassDecision);
	const judgeChangedDecision =
		record.judgeRawDecision !== undefined &&
		compassDecision !== (record.deterministicDecision as CompassDecision);
	const humanExplanation = composeVerdictExplanation(decision, reasons, {
		changedDecision: judgeChangedDecision,
		...(record.judgeRationale !== undefined
			? { rationale: record.judgeRationale }
			: {}),
	});

	return {
		deterministicDecision: evaluation.decision as string,
		evaluatedRules: evaluation.evaluatedRules,
		decision,
		riskLevel: hostedRiskLevelFor(compassDecision),
		reasons,
		humanExplanation,
		judgeClamped,
	};
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
	return { res, record, replayed: replayVerdict(record) };
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

		const replayed = replayVerdict(record);
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
		expect(replayVerdict(rowUnderEditedBuild).deterministicDecision).toBe(
			"REQUIRE_HUMAN_APPROVAL",
		);
		// ...and the untouched row still reproduces itself, because it carries its own.
		expect(replayVerdict(record).deterministicDecision).toBe(record.deterministicDecision);
		expect(replayVerdict(record).evaluatedRules).toEqual(record.evaluatedRules);
	});

	it("refuses to replay a row that predates the policy snapshot", async () => {
		const { record } = await decideAndReplay({ ran: false }, undefined);
		const legacy: VerdictRecord = { ...record };
		delete legacy.policySnapshot;
		expect(() => replayVerdict(legacy)).toThrow(/predates the policy snapshot/);
	});
});
