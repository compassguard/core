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

/**
 * Risk level for a decision that may have been refined *after* the policy engine
 * ran — e.g. escalated by a counterparty trust signal. hostedRiskLevelFor() keys
 * off the raw CompassDecision and would still report "low" for a payment the
 * trust layer pushed to deny.
 *
 * Agrees with hostedRiskLevelFor() on every unrefined decision, so callers that
 * switch to this see no behaviour change when no trust provider is configured.
 */
export function riskLevelForHostedDecision(
	decision: HostedDecision,
): HostedRiskLevel {
	switch (decision) {
		case HOSTED_DECISIONS.ALLOW:
			return HOSTED_RISK_LEVELS.LOW;
		case HOSTED_DECISIONS.DENY:
			return HOSTED_RISK_LEVELS.HIGH;
		default:
			return HOSTED_RISK_LEVELS.MEDIUM;
	}
}
