import { describe, expect, it } from "vitest";

import { buildAuditEvent } from "@back/guardrail/execution/executionGateway";
import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { loadDefaultPolicy } from "@hosted/policy/loadPolicy";
import { POLICY_REASON_CODES } from "@shared/policyContracts";

const policy = loadDefaultPolicy();

const actorWallet = "11111111111111111111111111111111";
const knownRecipient = "known_safe_address";
const unknownRecipient = "unknown_address";
const blockedRecipient = "known_bad_address";

async function loadTransferGateway() {
	try {
		return await import("../domains/transfer/transferGateway");
	} catch (error) {
		throw new Error(
			`Wave 3 transferGateway implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

async function loadTransferGatewayContracts() {
	try {
		return await import("../domains/transfer/transferGatewayContracts");
	} catch (error) {
		throw new Error(
			`Wave 3 transferGatewayContracts implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

function baseTransferInput(overrides: Record<string, unknown> = {}) {
	return {
		id: "transfer-candidate-1",
		network: "devnet",
		toolName: "transfer",
		actorWallet,
		amountSol: 0.05,
		recipientAddress: knownRecipient,
		recipientKnown: true,
		createdAt: "2026-06-06T00:00:00.000Z",
		quoteUsd: async () => ({ amountUsd: 5, source: "unit-test-sol-usd" }),
		policy,
		walletSafety: {
			status: "ALLOW",
			reasonCodes: ["LOCAL_VALIDATION_PASSED"],
		},
		...overrides,
	};
}

describe("Wave 3 transfer gateway", () => {
	it("exposes separated contracts/constants from behavior", async () => {
		const contracts = await loadTransferGatewayContracts();
		const gateway = await loadTransferGateway();

		expect(contracts.TRANSFER_AUDIT_LIFECYCLES).toMatchObject({
			PROPOSAL_CREATED: "proposal_created",
			PROPOSAL_REJECTED: "proposal_rejected",
			APPROVAL_RECEIVED: "approval_received",
			UNSIGNED_TX_PREPARED: "unsigned_tx_prepared",
			USER_REJECTED: "user_rejected",
			RESULT_SUBMITTED: "result_submitted",
			RESULT_CONFIRMED: "result_confirmed",
			RESULT_FAILED: "result_failed",
		});
		expect(gateway.evaluateTransferGateway).toEqual(expect.any(Function));
		expect(gateway.verifyTransferGatewayMetadata).toEqual(expect.any(Function));
		expect(gateway.buildTransferAuditEvent).toEqual(expect.any(Function));
	});

	it("builds a Solana transfer candidate through the Wave 1 gateway before policy", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(baseTransferInput());

		expect(result.classification).toMatchObject({
			toolName: "transfer",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
		});
		expect(result.classification.reasonCodes).toContain(
			"KNOWN_SENSITIVE_EXECUTION_TOOL",
		);
		expect(result.candidate).toMatchObject({
			id: "transfer-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer",
			actionKind: "transfer",
			actorWallet,
			createdAt: "2026-06-06T00:00:00.000Z",
			paramsSummary: {
				amountSol: 0.05,
				token: "SOL",
				recipient: knownRecipient,
			},
		});
		expect(result.candidate.paramsSummary.privateKey).toBeUndefined();
		expect(result.metadata).toMatchObject({
			candidateId: "transfer-candidate-1",
			policyId: "default-conservative",
		});
		expect(result.metadata.candidateFingerprint).toEqual(expect.any(String));
		expect(result.metadata.contextFingerprint).toEqual(expect.any(String));
	});

	it("derives transfer policy context from an injected SOL/USD quote and known recipient evidence", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(
			baseTransferInput({
				amountSol: 0.075,
				quoteUsd: async () => ({ amountUsd: 7.5, source: "unit-test-quote" }),
			}),
		);

		expect(result.policyContext).toMatchObject({
			amount_usd: 7.5,
			recipient_address: knownRecipient,
			recipient_known: true,
		});
		expect(result.candidate.evidence).toMatchObject({
			quoteSource: "unit-test-quote",
			walletSafetyStatus: "ALLOW",
		});
	});

	it("allows small transfers to known recipients but still marks them approval-card eligible", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(baseTransferInput());

		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.ALLOW,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT,
		);
		expect(result.policyEvaluation.evaluatedRules).toContain(
			"transfers.max_usd_without_approval",
		);
		expect(result.requiresApprovalCard).toBe(true);
		expect(result.proposalEligible).toBe(true);
	});

	it("requires human approval for unknown recipients under the default conservative policy", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(
			baseTransferInput({
				recipientAddress: unknownRecipient,
				recipientKnown: false,
			}),
		);

		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT,
		);
		expect(result.requiresApprovalCard).toBe(true);
		expect(result.proposalEligible).toBe(true);
	});

	it("fails closed with REQUIRE_ADDITIONAL_CONTEXT when quote/price evidence is unavailable", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(
			baseTransferInput({
				quoteUsd: async () => undefined,
			}),
		);

		expect(result.policyContext).not.toHaveProperty("amount_usd");
		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.TRANSFER_MISSING_AMOUNT,
		);
		expect(result.requiresApprovalCard).toBe(false);
		expect(result.proposalEligible).toBe(false);
		expect(result.failClosedReason).toBe("policy_requires_additional_context");
	});

	it("denies blocked recipients before proposal creation", async () => {
		const { evaluateTransferGateway } = await loadTransferGateway();

		const result = await evaluateTransferGateway(
			baseTransferInput({
				recipientAddress: blockedRecipient,
				recipientKnown: true,
			}),
		);

		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.DENY,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.TRANSFER_BLOCKED_RECIPIENT,
		);
		expect(result.requiresApprovalCard).toBe(false);
		expect(result.proposalEligible).toBe(false);
		expect(result.failClosedReason).toBe("policy_denied");
	});

	it.each([
		[COMPASS_DECISIONS.REQUIRE_SIMULATION, "policy_requires_simulation"],
		[COMPASS_DECISIONS.REQUIRE_POLICY_UPDATE, "policy_requires_policy_update"],
	] as const)("fails closed for future/unhandled policy decision %s", async (decision, failClosedReason) => {
		const { gateTransferPolicyDecision } = await loadTransferGateway();

		const gate = gateTransferPolicyDecision({
			decision,
			policyId: "default-conservative",
			reasonCodes: ["FUTURE_POLICY_REASON"],
			evaluatedRules: ["future.rule"],
		});

		expect(gate).toEqual({
			proposalEligible: false,
			requiresApprovalCard: false,
			failClosedReason,
		});
	});

	it("recomputes approval metadata from deterministic proposal fields before unsigned tx build", async () => {
		const {
			evaluateTransferGateway,
			buildTransferGatewayApprovalMetadata,
			verifyTransferGatewayMetadata,
		} = await loadTransferGateway();
		const original = await evaluateTransferGateway(baseTransferInput());

		const current = buildTransferGatewayApprovalMetadata({
			stored: original.metadata,
			candidateId: "transfer-candidate-1",
			network: "devnet",
			toolName: "transfer",
			actorWallet,
			amountSol: 0.05,
			recipientAddress: knownRecipient,
			createdAt: "2026-06-06T00:00:00.000Z",
		});

		expect(
			verifyTransferGatewayMetadata({ stored: original.metadata, current }),
		).toEqual({ ok: true });

		const wrongCandidateId = buildTransferGatewayApprovalMetadata({
			stored: original.metadata,
			candidateId: "transfer-different-action-hash",
			network: "devnet",
			toolName: "transfer",
			actorWallet,
			amountSol: 0.05,
			recipientAddress: knownRecipient,
			createdAt: "2026-06-06T00:00:00.000Z",
		});

		expect(
			verifyTransferGatewayMetadata({
				stored: original.metadata,
				current: wrongCandidateId,
			}),
		).toEqual({
			ok: false,
			reason: "gateway_metadata_mismatch",
			mismatchedFields: ["candidateId", "candidateFingerprint"],
		});

		const tampered = buildTransferGatewayApprovalMetadata({
			stored: original.metadata,
			candidateId: "transfer-candidate-1",
			network: "devnet",
			toolName: "transfer",
			actorWallet,
			amountSol: 0.06,
			recipientAddress: knownRecipient,
			createdAt: "2026-06-06T00:00:00.000Z",
		});

		expect(
			verifyTransferGatewayMetadata({
				stored: original.metadata,
				current: tampered,
			}),
		).toEqual({
			ok: false,
			reason: "gateway_metadata_mismatch",
			mismatchedFields: ["candidateFingerprint"],
		});
	});

	it("detects transfer gateway metadata fingerprint mismatches before unsigned tx build", async () => {
		const { evaluateTransferGateway, verifyTransferGatewayMetadata } =
			await loadTransferGateway();
		const original = await evaluateTransferGateway(baseTransferInput());

		const verification = verifyTransferGatewayMetadata({
			stored: original.metadata,
			current: {
				...original.metadata,
				candidateFingerprint: "tampered-fingerprint",
			},
		});

		expect(verification).toEqual({
			ok: false,
			reason: "gateway_metadata_mismatch",
			mismatchedFields: ["candidateFingerprint"],
		});
	});

	it("builds redacted audit events with policy reasons in metadata, not classification reasonCodes", async () => {
		const { evaluateTransferGateway, buildTransferAuditEvent } =
			await loadTransferGateway();
		const evaluation = await evaluateTransferGateway(
			baseTransferInput({
				recipientAddress: unknownRecipient,
				recipientKnown: false,
			}),
		);

		const event = buildTransferAuditEvent({
			id: "audit-transfer-1",
			occurredAt: "2026-06-06T00:00:01.000Z",
			lifecycle: "proposal_created",
			evaluation,
			approvalStatus: "pending",
			result: "pending",
			metadata: {
				apiKey: "must-not-leak",
				rawUserPrompt: "send 0.05 SOL to unknown_address",
				nested: { authorization: "Bearer must-not-leak" },
			},
		});

		expect(event).toMatchObject({
			id: "audit-transfer-1",
			occurredAt: "2026-06-06T00:00:01.000Z",
			candidateId: evaluation.candidate.id,
			chain: "solana",
			network: "devnet",
			toolName: "transfer",
			actionKind: "transfer",
			actorWallet,
			riskClass: "SENSITIVE_EXECUTION",
			policyId: "default-conservative",
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			approvalStatus: "pending",
			result: "pending",
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			metadata: {
				lifecycle: "proposal_created",
				policyReasonCodes: [POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT],
				evaluatedRules: ["transfers.require_approval_for_unknown_recipient"],
				apiKey: "[REDACTED]",
				rawUserPrompt: "[REDACTED]",
				nested: { authorization: "[REDACTED]" },
			},
		});
		expect(event.reasonCodes).not.toContain(
			POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT,
		);
	});

	it("uses the Wave 1 audit redaction boundary for transfer audit metadata", () => {
		const candidate = {
			id: "candidate-redaction",
			chain: "solana" as const,
			network: "devnet",
			toolName: "transfer",
			actionKind: "transfer",
			actorWallet,
			createdAt: "2026-06-06T00:00:00.000Z",
			paramsSummary: {},
		};
		const classification = {
			toolName: "transfer",
			riskClass: "SENSITIVE_EXECUTION" as const,
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		};

		const event = buildAuditEvent({
			candidate,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			metadata: {
				policyReasonCodes: [POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT],
				apiKey: "must-not-leak",
				rawUserPrompt: "must-not-leak",
			},
		});

		expect(event.reasonCodes).toEqual(["KNOWN_SENSITIVE_EXECUTION_TOOL"]);
		expect(event.metadata).toMatchObject({
			policyReasonCodes: [POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT],
			apiKey: "[REDACTED]",
			rawUserPrompt: "[REDACTED]",
		});
	});
});
