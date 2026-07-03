import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { debug } from "../debugLogger";
import {
	POLICY_OUTCOMES,
	type EvaluateActionInput,
	type PolicyEvaluation,
	type PolicyOutcome,
} from "@shared/policyContracts";

export function decisionFromOutcome(
	input: EvaluateActionInput,
	outcome: PolicyOutcome,
	reasonCodes: string[],
	evaluatedRules: string[],
): PolicyEvaluation {
	return policyResult(
		input,
		mapPolicyOutcome(outcome),
		reasonCodes,
		evaluatedRules,
	);
}

export function policyResult(
	input: EvaluateActionInput,
	decisionValue: PolicyEvaluation["decision"],
	reasonCodes: string[],
	evaluatedRules: string[],
): PolicyEvaluation {
	debug("policy", "applyDecision", "Policy decision applied", {
		toolName: input.candidate.toolName,
		decision: decisionValue as string,
		evaluatedRules,
	});
	return {
		decision: decisionValue,
		policyId: input.policy.policy_id,
		reasonCodes,
		evaluatedRules,
	};
}

export function isNonNegativeFiniteNumber(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function mapPolicyOutcome(
	outcome: PolicyOutcome,
): PolicyEvaluation["decision"] {
	switch (outcome) {
		case POLICY_OUTCOMES.ALLOW:
			return COMPASS_DECISIONS.ALLOW;
		case POLICY_OUTCOMES.DENY:
		case POLICY_OUTCOMES.DENY_UNLESS_COMPASS_BUILT:
			return COMPASS_DECISIONS.DENY;
		case POLICY_OUTCOMES.REQUIRE_APPROVAL:
			return COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL;
		case POLICY_OUTCOMES.REQUIRE_SIMULATION:
			return COMPASS_DECISIONS.REQUIRE_SIMULATION;
		case POLICY_OUTCOMES.REQUIRE_POLICY_UPDATE:
			return COMPASS_DECISIONS.REQUIRE_POLICY_UPDATE;
		case POLICY_OUTCOMES.REQUIRE_ADDITIONAL_CONTEXT:
			return COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT;
	}
}
