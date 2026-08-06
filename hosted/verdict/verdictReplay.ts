import {
	createActionCandidate,
} from "@back/guardrail/execution/executionGateway";
import type { CompassDecision } from "@shared/executionGatewayContracts";
import type { HostedDecision } from "@shared/evaluationContracts";
import type { IntentSource } from "@shared/mandateContracts";
import type { LlmGuardDecision, LlmGuardOutput } from "@shared/llmDecisionContracts";

import { clampLlmDecision } from "../llm/llmDecisionAdapter";
import {
	collapseToHostedDecision,
	hostedRiskLevelFor,
} from "../evaluate/hostedDecision";
import {
	composeVerdictExplanation,
	mergeJudgeReasons,
} from "../verify/humanExplanation";
import { evaluateAction } from "../policy/policyEngine";
import { VERIFY_JUDGE_REASON_UNAVAILABLE } from "../verify/verifyJudge";
import { readEngineVersion } from "./engineVersion";
import type { VerdictRecord } from "./verdictStoreTypes";

/**
 * Verdict reconstruction — re-derive a decision from its stored row ALONE (no request, no live
 * LLM). This is the shipped implementation; `verdictReplay.test.ts` and
 * `scripts/replay-verdict.ts` both consume it, so the reconstruction proof tests what actually
 * runs rather than a private copy (plan R1).
 *
 * BOTH compiled-in inputs come from the row, never from the current build:
 *   - policySnapshot   — policyId/policyVersion only NAME the rulebook, and a threshold can be
 *                        edited without a version bump, so identity cannot detect drift (D4a).
 *   - toolClassification — classifyToolCall() reads module-level tool sets, so re-deriving it
 *                        from toolName reclassifies past verdicts whenever those sets change (D4b).
 *
 * The judge leg is NOT re-run: an LLM is a recorded actor, not a replayable function. Its
 * recorded output re-enters the REAL clamp, which must reproduce the stored post-judge decision.
 *
 * WHAT REPLAY STILL CANNOT PIN: the engine code itself (clamp, collapse, explanation
 * composition, the policy engine) runs from the CURRENT build. Code cannot be snapshotted, so
 * the row records WHICH BUILD decided (engineVersion) and replay reports a mismatch as a
 * WARNING rather than a refusal — the decision-bearing inputs are snapshotted, so replay is
 * usually still correct, and the caller decides whether to trust it (plan R4).
 */

/** The reproduced decision surface, for comparison against what the row itself recorded. */
export type ReplayedVerdict = {
	deterministicDecision: string;
	evaluatedRules: string[];
	decision: HostedDecision;
	riskLevel: ReturnType<typeof hostedRiskLevelFor>;
	reasons: string[];
	humanExplanation: string;
	judgeClamped: boolean | undefined;
	/**
	 * Which check actually ran. Persisted on the row and part of the /verify response, so it
	 * belongs in the reproduced surface — leaving it out let a row whose stored intentSource
	 * disagreed with its judge fields still compare as a clean match.
	 */
	intentSource: IntentSource;
	/**
	 * Set when the row was decided by a DIFFERENT build than the one replaying it, or when the
	 * row carries no engineVersion at all. Advisory: the snapshotted inputs still drive the
	 * result, but engine-code changes since then are invisible to this replay.
	 */
	engineVersionWarning?: string;
};

/**
 * Why a row could not be replayed. A VALUE, not an exception (plan R3): every verdict written
 * before the reconstruction fields existed takes this path, so it is the common case for
 * historical data and a caller must be able to report it rather than catch it.
 */
export type ReplayRefusal = {
	ok: false;
	reason: string;
	/** The specific field whose absence blocked replay — for callers that group refusals. */
	missingField:
		| "toolName"
		| "policyContext"
		| "policySnapshot"
		| "toolClassification"
		| "deterministicDecision";
};

export type ReplayResult = ({ ok: true } & ReplayedVerdict) | ReplayRefusal;

export function replayVerdict(
	record: VerdictRecord,
	options: { currentEngineVersion?: string } = {},
): ReplayResult {
	if (record.toolName === undefined) {
		return {
			ok: false,
			missingField: "toolName",
			reason: "row predates the reconstruction fields (no toolName) — not replayable",
		};
	}
	if (record.policyContext === undefined) {
		return {
			ok: false,
			missingField: "policyContext",
			reason: "row predates the reconstruction fields (no policyContext) — not replayable",
		};
	}
	if (record.policySnapshot === undefined) {
		return {
			ok: false,
			missingField: "policySnapshot",
			reason:
				"row predates the policy snapshot — the rulebook that decided it was never " +
				"recorded, and the current build's policy may differ without a version bump",
		};
	}
	if (record.toolClassification === undefined) {
		return {
			ok: false,
			missingField: "toolClassification",
			reason:
				"row predates the tool-classification snapshot — re-deriving it would read " +
				"today's tool sets and could silently reclassify this verdict",
		};
	}

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
		classification: record.toolClassification,
		context: record.policyContext,
		policy: record.policySnapshot,
	});

	// A judged row without its pre-judge floor cannot be replayed HONESTLY: the clamp is defined
	// relative to the deterministic decision, so clamping against undefined would silently
	// produce a verdict the original clamp never computed and still report ok:true. The normal
	// service writes both together; the store's type and schema nonetheless permit one without
	// the other, so refuse explicitly rather than trusting every future writer.
	if (record.judgeRawDecision !== undefined && record.deterministicDecision === undefined) {
		return {
			ok: false,
			missingField: "deterministicDecision",
			reason:
				"row records a judge decision but not the pre-judge deterministic decision, so " +
				"the strictness clamp has no floor to replay against — not replayable",
		};
	}

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
	} else if (judgeWasUnavailable(record)) {
		// The judge was called and did not answer, so the service appended judge_unavailable.
		// Replay must reproduce it: the row is deliberately fail-HONEST about a degraded check,
		// and a reconstruction that dropped it would claim a cleaner decision than happened.
		reasons = [...reasons, VERIFY_JUDGE_REASON_UNAVAILABLE];
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

	const running = options.currentEngineVersion ?? readEngineVersion();
	const engineVersionWarning = describeEngineDrift(record.engineVersion, running);

	return {
		ok: true,
		// "self_report" exactly when the judge produced a decision (verifyService.ts:158).
		intentSource: record.judgeRawDecision !== undefined ? "self_report" : "none",
		deterministicDecision: evaluation.decision as string,
		evaluatedRules: evaluation.evaluatedRules,
		decision,
		riskLevel: hostedRiskLevelFor(compassDecision),
		reasons,
		humanExplanation,
		judgeClamped,
		...(engineVersionWarning !== undefined ? { engineVersionWarning } : {}),
	};
}

/**
 * Did the judge run and fail? Prefer the RECORDED judgeStatus. Fall back to the old inference
 * ("mandate snapshot present, no judge output") only for rows written before judgeStatus
 * existed — that inference held for every shipped writer, but the record contract permits a
 * type-valid row that snapshots a mandate without attempting a judge, which the inference would
 * misread as unavailable. Recorded fact first, inference only where no fact was recorded.
 */
function judgeWasUnavailable(record: VerdictRecord): boolean {
	if (record.judgeStatus !== undefined) return record.judgeStatus === "unavailable";
	return record.mandateSnapshot !== undefined;
}

/** Advisory build-drift note; undefined when the row and the running build agree. */
function describeEngineDrift(
	rowVersion: string | undefined,
	runningVersion: string | undefined,
): string | undefined {
	if (rowVersion === undefined) {
		return (
			"row carries no engineVersion, so the build that decided it is unknown; " +
			"engine-code changes since then are invisible to this replay"
		);
	}
	if (runningVersion === undefined) {
		return `row was decided by build ${rowVersion}; the running build is unidentified`;
	}
	if (rowVersion !== runningVersion) {
		return (
			`row was decided by build ${rowVersion}, replaying on ${runningVersion}: the ` +
			"snapshotted policy and classification still drive the result, but engine code " +
			`(clamp, collapse, explanation) may differ — check out ${rowVersion} to be exact`
		);
	}
	return undefined;
}
