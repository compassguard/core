import { describe, expect, it } from "vitest";

import {
	HOSTED_DECISIONS,
	HOSTED_RISK_LEVELS,
	isHostedDecision,
	isHostedRiskLevel,
} from "@hosted/evaluate/evaluationContracts";
import {
	DEFAULT_AUDIT_QUERY_LIMIT,
	MAX_AUDIT_QUERY_LIMIT,
	normalizeAuditQueryLimit,
} from "@hosted/audit/auditContracts";
import type { PolicySnapshotResponse } from "@hosted/policies/policyContracts";
import {
	HOSTED_CLIENT_ERROR_CODES,
	validateEvaluateActionResponse,
} from "../mcp/proxy/mcpHostedClientContracts";
import type {
	ProxyCallToolResult,
	ProxyDecision,
} from "../mcp/proxy/mcpProxyContracts";

describe("hybrid hosted contracts", () => {
	it("exposes canonical hosted decisions and risk levels", () => {
		expect(Object.values(HOSTED_DECISIONS)).toEqual(["allow", "deny", "confirm"]);
		expect(Object.values(HOSTED_RISK_LEVELS)).toEqual([
			"low",
			"medium",
			"high",
			"unknown",
		]);
		expect(isHostedDecision("allow")).toBe(true);
		expect(isHostedDecision("blocked")).toBe(false);
		expect(isHostedRiskLevel("high")).toBe(true);
		expect(isHostedRiskLevel("critical")).toBe(false);
	});

	it("normalizes audit list limits for hosted queries", () => {
		expect(DEFAULT_AUDIT_QUERY_LIMIT).toBe(25);
		expect(MAX_AUDIT_QUERY_LIMIT).toBe(100);
		expect(normalizeAuditQueryLimit(undefined)).toBe(DEFAULT_AUDIT_QUERY_LIMIT);
		expect(normalizeAuditQueryLimit(5)).toBe(5);
		expect(normalizeAuditQueryLimit(999)).toBe(MAX_AUDIT_QUERY_LIMIT);
		expect(normalizeAuditQueryLimit(0)).toBe(1);
	});

	it("validates hosted evaluation responses fail-closed", () => {
		const validResult = validateEvaluateActionResponse({
			correlationId: "corr_123",
			decision: "allow",
			riskLevel: "low",
			reasons: ["READ_ONLY_BY_POLICY"],
			auditRef: "aud_123",
		});

		expect(validResult).toEqual({
			ok: true,
			response: {
				correlationId: "corr_123",
				decision: "allow",
				riskLevel: "low",
				reasons: ["READ_ONLY_BY_POLICY"],
				auditRef: "aud_123",
			},
		});

		const invalidResult = validateEvaluateActionResponse({
			correlationId: "corr_123",
			decision: "allow",
			riskLevel: "low",
			reasons: ["READ_ONLY_BY_POLICY"],
		});

		expect(invalidResult).toEqual({
			ok: false,
			error: {
				code: HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				message: "Hosted evaluation response is missing a valid auditRef.",
			},
		});
	});

	it("keeps proxy contracts ready for hosted decisions and audit refs", () => {
		const decision: ProxyDecision = {
			outcome: "require_approval",
			reason: "Hosted confirmation required.",
			hostedDecision: "confirm",
			suggestedAction: "Ask the user for confirmation.",
		};
		const result: ProxyCallToolResult = {
			outcome: "require_approval",
			reason: "Hosted confirmation required.",
			policyDecision: decision,
			auditRef: "aud_123",
		};
		const policyResponse: PolicySnapshotResponse = {
			version: "2026-06-17",
			updatedAt: "2026-06-17T12:00:00.000Z",
			rules: {
				transfers: { maxUsdWithoutApproval: 10 },
			},
		};

		expect(result.auditRef).toBe("aud_123");
		expect(result.policyDecision?.hostedDecision).toBe("confirm");
		expect(policyResponse.rules).toEqual({
			transfers: { maxUsdWithoutApproval: 10 },
		});
	});
});
