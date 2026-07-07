import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import type { CompassDecision } from "@shared/executionGatewayContracts";
import {
	HOSTED_DECISIONS,
	HOSTED_RISK_LEVELS,
} from "@shared/evaluationContracts";
import type {
	HostedDecision,
	HostedRiskLevel,
} from "@shared/evaluationContracts";

export function collapseToHostedDecision(
	decision: CompassDecision,
): HostedDecision {
	switch (decision) {
		case COMPASS_DECISIONS.ALLOW:
			return HOSTED_DECISIONS.ALLOW;
		case COMPASS_DECISIONS.DENY:
			return HOSTED_DECISIONS.DENY;
		default:
			return HOSTED_DECISIONS.REVIEW;
	}
}

export function hostedRiskLevelFor(
	decision: CompassDecision,
): HostedRiskLevel {
	switch (decision) {
		case COMPASS_DECISIONS.ALLOW:
			return HOSTED_RISK_LEVELS.LOW;
		case COMPASS_DECISIONS.DENY:
			return HOSTED_RISK_LEVELS.HIGH;
		default:
			return HOSTED_RISK_LEVELS.MEDIUM;
	}
}
