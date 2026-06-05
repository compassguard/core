import { describe, expect, it } from "vitest";

import {
	buildAuditEvent,
	classifyToolCall,
	createActionCandidate,
} from "../executionGateway";
import {
	COMPASS_DECISIONS,
	TOOL_RISK_CLASSES,
} from "../executionGatewayContracts";

describe("execution gateway contracts", () => {
	it("exposes the canonical Wave 1 decision values", () => {
		expect(Object.values(COMPASS_DECISIONS)).toEqual([
			"ALLOW",
			"DENY",
			"REQUIRE_HUMAN_APPROVAL",
			"REQUIRE_SIMULATION",
			"REQUIRE_POLICY_UPDATE",
			"REQUIRE_ADDITIONAL_CONTEXT",
		]);
	});

	it("exposes the canonical tool risk classes", () => {
		expect(Object.values(TOOL_RISK_CLASSES)).toEqual([
			"READ_ONLY",
			"PREPARATION_SIMULATION",
			"SENSITIVE_EXECUTION",
			"SIGNING",
			"BLOCKED_UNKNOWN",
		]);
	});

	it("allows known read-only tools and requires audit", () => {
		const result = classifyToolCall({ toolName: "get_wallet_holdings" });

		expect(result).toMatchObject({
			toolName: "get_wallet_holdings",
			riskClass: "READ_ONLY",
			defaultDecision: "ALLOW",
			auditRequired: true,
		});
		expect(result.reasonCodes).toContain("KNOWN_READ_ONLY_TOOL");
	});

	it("denies direct sign and send tools unless a later policy proves Compass approval", () => {
		const result = classifyToolCall({ toolName: "sign_and_send_transaction" });

		expect(result).toMatchObject({
			riskClass: "SIGNING",
			defaultDecision: "DENY",
			auditRequired: true,
		});
		expect(result.reasonCodes).toContain("DIRECT_SIGN_AND_SEND_BLOCKED");
	});

	it("denies unknown mutating tools by default", () => {
		const result = classifyToolCall({
			toolName: "mystery_transfer",
			mutates: true,
		});

		expect(result).toMatchObject({
			riskClass: "BLOCKED_UNKNOWN",
			defaultDecision: "DENY",
			auditRequired: true,
		});
		expect(result.reasonCodes).toContain("UNKNOWN_MUTATING_TOOL");
	});

	it("creates a canonical Solana action candidate without raw sensitive params", () => {
		const candidate = createActionCandidate({
			id: "candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer_sol",
			actionKind: "transfer",
			actorWallet: "11111111111111111111111111111111",
			createdAt: "2026-06-03T00:00:00.000Z",
			params: {
				amount: 1,
				token: "SOL",
				recipient: "So11111111111111111111111111111111111111112",
				privateKey: "must-not-leak",
			},
			evidence: {
				source: "unit-test",
			},
		});

		expect(candidate).toEqual({
			id: "candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer_sol",
			actionKind: "transfer",
			actorWallet: "11111111111111111111111111111111",
			createdAt: "2026-06-03T00:00:00.000Z",
			paramsSummary: {
				amount: 1,
				token: "SOL",
				recipient: "So11111111111111111111111111111111111111112",
				privateKey: "[REDACTED]",
			},
			evidence: {
				source: "unit-test",
			},
		});
	});

	it("builds redacted audit events with the minimum gateway fields", () => {
		const candidate = createActionCandidate({
			id: "candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer_sol",
			actionKind: "transfer",
			actorWallet: "11111111111111111111111111111111",
			createdAt: "2026-06-03T00:00:00.000Z",
			params: {
				amount: 1,
				token: "SOL",
				recipient: "So11111111111111111111111111111111111111112",
			},
		});
		const classification = classifyToolCall({
			toolName: "transfer_sol",
			mutates: true,
		});

		const event = buildAuditEvent({
			id: "audit-1",
			occurredAt: "2026-06-03T00:00:01.000Z",
			candidate,
			classification,
			policyId: "default-conservative",
			decision: "REQUIRE_HUMAN_APPROVAL",
			riskScore: 78,
			approvalStatus: "pending",
			transactionSignature: "5j7abc",
			result: "pending",
			metadata: {
				actionHash: "hash-123",
				apiKey: "must-not-leak",
				rawUserPrompt: "send my funds somewhere",
				authorization: "Bearer must-not-leak",
				nested: {
					cookie: "session=must-not-leak",
					jwt: "must-not-leak",
					sessionToken: "must-not-leak",
					prompt: "raw prompt should not be audited",
				},
			},
		});

		expect(event).toEqual({
			id: "audit-1",
			occurredAt: "2026-06-03T00:00:01.000Z",
			candidateId: "candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer_sol",
			actionKind: "transfer",
			actorWallet: "11111111111111111111111111111111",
			riskClass: "SENSITIVE_EXECUTION",
			policyId: "default-conservative",
			decision: "REQUIRE_HUMAN_APPROVAL",
			riskScore: 78,
			approvalStatus: "pending",
			transactionSignature: "5j7abc",
			result: "pending",
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			metadata: {
				actionHash: "hash-123",
				apiKey: "[REDACTED]",
				rawUserPrompt: "[REDACTED]",
				authorization: "[REDACTED]",
				nested: {
					cookie: "[REDACTED]",
					jwt: "[REDACTED]",
					sessionToken: "[REDACTED]",
					prompt: "[REDACTED]",
				},
			},
		});
	});
});
