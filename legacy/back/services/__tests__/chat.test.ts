import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transferGateway", () => ({
	evaluateTransferGateway: vi.fn(),
	gateTransferPolicyDecision: vi.fn(),
	buildTransferGatewayApprovalMetadata: vi.fn(({ stored }) => stored),
	verifyTransferGatewayMetadata: vi.fn(),
	buildTransferAuditEvent: vi.fn(),
}));

import { web3 } from "@coral-xyz/anchor";

import {
	getAgentToolNames,
	evaluateSolTransferFunding,
	isReadOnlyAgentTool,
	maskSolanaAddressesForModel,
	normalizeMessages,
	parseDirectTransferIntent,
	proxyAgenticChat,
	restoreMaskedSolanaAddressesInToolArgs,
} from "../chat";
import { COMPASS_DECISIONS } from "../executionGatewayContracts";
import { prepareTransferResult } from "../tools/transfer";
import { createSession, getSession } from "../chatSessionStore";
import * as azureResponsesClient from "../azureResponsesClient";
import * as transferGateway from "../transferGateway";

function makeCompletionStream(content: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const payload = JSON.stringify({
		type: "response.completed",
		response: {
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: content,
						},
					],
				},
			],
		},
	});

	const rawChunk = `data: ${payload}\n\n`;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(rawChunk));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
}

function makeTerminalDoneStream(content: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const payload = JSON.stringify({
		type: "response.output_text.done",
		text: content,
	});

	const rawChunk = `data: ${payload}\n\n`;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(rawChunk));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
}

type ParsedSseEvent = {
	event: string;
	data: Record<string, unknown>;
};

function parseSseEvents(body: string): ParsedSseEvent[] {
	return body
		.split("\n\n")
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const event = chunk.match(/^event: (.+)$/m)?.[1] ?? "message";
			const dataRaw = chunk.match(/^data: (.+)$/m)?.[1] ?? "{}";
			return { event, data: JSON.parse(dataRaw) as Record<string, unknown> };
		});
}

const chatPolicyUserWallet = "11111111111111111111111111111111";
const chatPolicyRecipient = "So11111111111111111111111111111111111111112";

function mockTransferRuntimePrechecks() {
	process.env.OPENAI_API_KEY = "test-key";
	process.env.AGENT_ACTION_GUARD_PROGRAM_ID =
		"11111111111111111111111111111111";
	process.env.WALLET_SAFETY_PROVIDER_MODE = "internal-only";
	process.env.WALLET_SAFETY_SOLSCAN_ENABLED = "false";
	process.env.GUARDRAIL_NARRATION_ENABLED = "false";
	process.env.SOLANA_RPC_URL = "http://127.0.0.1:8899";

	vi.spyOn(web3.Connection.prototype, "getBalance").mockResolvedValue(
		10_000_000_000,
	);
	vi.spyOn(web3.Connection.prototype, "getAccountInfo").mockResolvedValue(null);
	vi.spyOn(
		web3.Connection.prototype,
		"getMinimumBalanceForRentExemption",
	).mockResolvedValue(1_000);
}

function buildMockTransferGatewayEvaluation(
	decision: string,
	overrides: {
		proposalEligible?: boolean;
		requiresApprovalCard?: boolean;
		failClosedReason?: string;
		reasonCodes?: string[];
		evaluatedRules?: string[];
	} = {},
) {
	const proposalEligible =
		overrides.proposalEligible ??
		(decision === COMPASS_DECISIONS.ALLOW ||
			decision === COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL);
	const requiresApprovalCard =
		overrides.requiresApprovalCard ?? proposalEligible;

	return {
		proposalEligible,
		requiresApprovalCard,
		failClosedReason: overrides.failClosedReason,
		classification: {
			toolName: "transfer",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		},
		candidate: {
			id: "chat-transfer-candidate",
			chain: "solana",
			network: "devnet",
			toolName: "transfer",
			actionKind: "transfer",
			actorWallet: chatPolicyUserWallet,
			createdAt: "2026-06-06T00:00:00.000Z",
			paramsSummary: {
				amountSol: 0.05,
				token: "SOL",
				recipient: chatPolicyRecipient,
			},
		},
		policyContext: {
			amount_usd: 5,
			recipient_address: chatPolicyRecipient,
			recipient_known: true,
		},
		policyEvaluation: {
			policyId: "default-conservative",
			decision,
			reasonCodes: overrides.reasonCodes ?? ["CHAT_POLICY_TEST_REASON"],
			evaluatedRules: overrides.evaluatedRules ?? ["chat.policy.test"],
		},
		metadata: {
			candidateId: "chat-transfer-candidate",
			candidateFingerprint: "candidate-fingerprint",
			policyId: "default-conservative",
			decision,
			reasonCodes: overrides.reasonCodes ?? ["CHAT_POLICY_TEST_REASON"],
			evaluatedRules: overrides.evaluatedRules ?? ["chat.policy.test"],
			classificationReasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			contextFingerprint: "context-fingerprint",
			evaluatedAt: "2026-06-06T00:00:00.000Z",
		},
	};
}

async function requestDirectTransfer(sessionId: string) {
	return proxyAgenticChat({
		type: "user_message",
		content: `Manda 0.05 SOL ${chatPolicyRecipient}`,
		session_id: sessionId,
		user_address: chatPolicyUserWallet,
	});
}

async function requestTransferApproval(sessionId: string, actionHash?: string) {
	return proxyAgenticChat({
		type: "function_approve",
		session_id: sessionId,
		user_address: chatPolicyUserWallet,
		...(actionHash ? { action_hash: actionHash } : {}),
	});
}

async function createApprovalReadyWave3TransferProposal(
	sessionId: string,
	decision = COMPASS_DECISIONS.ALLOW,
) {
	vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
		buildMockTransferGatewayEvaluation(decision, {
			reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
			evaluatedRules: ["transfers.max_usd_without_approval"],
		}) as never,
	);

	const proposalResponse = await requestDirectTransfer(sessionId);
	expect(proposalResponse.status).toBe(200);
	await proposalResponse.text();

	const pendingProposal = getSession(sessionId)?.pendingProposal;
	expect(pendingProposal).toMatchObject({
		proposalType: "transfer",
		state: "awaiting_approval",
		toolName: "transfer",
	});
	expect(pendingProposal?.actionHash).toEqual(expect.any(String));
	return pendingProposal!;
}

function getTransferAuditCall(lifecycle: string) {
	return vi
		.mocked(transferGateway.buildTransferAuditEvent)
		.mock.calls.find(
			([input]) => (input as { lifecycle?: string }).lifecycle === lifecycle,
		)?.[0] as Record<string, unknown> | undefined;
}

describe("chat agent tool catalog", () => {
	it("includes backend managed read-only context tools", () => {
		const toolNames = getAgentToolNames();
		expect(toolNames).toEqual(
			expect.arrayContaining(["get_wallet_holdings", "get_usdc_sol_quote"]),
		);
		expect(isReadOnlyAgentTool("get_wallet_holdings")).toBe(true);
		expect(isReadOnlyAgentTool("get_usdc_sol_quote")).toBe(true);
		expect(isReadOnlyAgentTool("transfer")).toBe(false);
	});
});

describe("chat history endpoint", () => {
	beforeEach(() => {
		process.env.OPENAI_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns session_not_found for unknown session", async () => {
		const response = await proxyAgenticChat({
			type: "get_history",
			session_id: "session-missing",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns persisted messages and pending proposal in history", async () => {
		const sessionId = "session-history-1";
		const session = createSession(sessionId, "thread-history-1", "wallet-1");
		const proposalMessage = {
			id: "pending-msg-1",
			role: "agent" as const,
			type: "function_call" as const,
			function: {
				name: "transfer" as const,
				params: {
					amount: 1,
					token: "SOL",
					recipient: "11111111111111111111111111111111",
				},
			},
			display: {
				summary: "Prepare transfer",
			},
			risk: {
				score: 10,
				level: "low" as const,
			},
			execution: {
				mode: "phantom_sign_and_send" as const,
				network: "devnet" as const,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			},
			timestamp: new Date().toISOString(),
		};
		session.messages = [proposalMessage];
		session.pendingProposal = {
			toolName: "transfer",
			toolArgs: {
				amount: 1,
				token: "SOL",
				recipient: "11111111111111111111111111111111",
			},
			toolResult: {
				status: "prepared",
				reason: "pending",
			},
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			expectedUserAddress: "wallet-1",
			state: "awaiting_approval",
			proposalType: "transfer",
			network: "devnet",
			proposalMessage,
		};

		const response = await proxyAgenticChat({
			type: "get_history",
			session_id: sessionId,
			user_address: "wallet-1",
		});

		expect(response.status).toBe(200);
		const payload = await response.json();

		expect(payload.session_id).toBe(sessionId);
		expect(payload.pending_proposal).not.toBeNull();
		expect(payload.messages).toHaveLength(1);
		expect(payload.messages[0]).toMatchObject({
			role: "agent",
			type: "function_call",
			function: {
				name: "transfer",
			},
		});
	});

	it("returns session_not_found for get_history if wallet-bound session omits user_address", async () => {
		createSession(
			"session-history-no-user",
			"thread-history-no-user",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "get_history",
			session_id: "session-history-no-user",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for get_history if wallet-bound session has mismatched user_address", async () => {
		createSession(
			"session-history-mismatch",
			"thread-history-mismatch",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "get_history",
			session_id: "session-history-mismatch",
			user_address: "wallet-2",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("includes previous transcript when building model input for user message", async () => {
		const sessionId = "session-history-2";
		const session = createSession(sessionId, "thread-history-2", "wallet-1");
		session.messages.push({
			id: "seed-1",
			role: "user",
			type: "text",
			content: "¿Cómo estás?",
			timestamp: new Date(Date.now() - 60_000).toISOString(),
		});

		const completionSpy = vi
			.spyOn(azureResponsesClient, "callAzureResponses")
			.mockResolvedValueOnce({
				id: "r1",
				object: "response",
				status: "completed",
				output: [],
			});
		vi.spyOn(
			azureResponsesClient,
			"callAzureResponsesStream",
		).mockResolvedValueOnce(makeCompletionStream("Te ayudo con eso"));

		const response = await proxyAgenticChat({
			type: "user_message",
			content: "Y para hoy qué me recomiendas?",
			session_id: sessionId,
			user_address: "wallet-1",
		});

		expect(response.status).toBe(200);
		await response.text();
		expect(completionSpy).toHaveBeenCalledTimes(1);
		const callArgs = completionSpy.mock.calls[0]?.[0];
		expect(callArgs?.input).toContain("[Usuario]: ¿Cómo estás?");
		expect(callArgs?.input).toContain(
			"[Usuario]: Y para hoy qué me recomiendas?",
		);
	});

	it("persists assistant text from terminal stream done events", async () => {
		const sessionId = "session-terminal-done";
		createSession(sessionId, "thread-terminal-done", "wallet-1");

		vi.spyOn(azureResponsesClient, "callAzureResponses").mockResolvedValueOnce({
			id: "r-terminal",
			object: "response",
			status: "completed",
			output: [],
		});
		vi.spyOn(
			azureResponsesClient,
			"callAzureResponsesStream",
		).mockResolvedValueOnce(
			makeTerminalDoneStream("Respuesta final desde done"),
		);

		const response = await proxyAgenticChat({
			type: "user_message",
			content: "Dame un resumen",
			session_id: sessionId,
			user_address: "wallet-1",
		});

		expect(response.status).toBe(200);
		const sseBody = await response.text();
		expect(sseBody).toContain("Respuesta final desde done");

		const session = getSession(sessionId);
		expect(session?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "agent",
					type: "text",
					content: "Respuesta final desde done",
				}),
			]),
		);

		const historyResponse = await proxyAgenticChat({
			type: "get_history",
			session_id: sessionId,
			user_address: "wallet-1",
		});
		const history = await historyResponse.json();
		expect(history.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "agent",
					type: "text",
					content: "Respuesta final desde done",
				}),
			]),
		);
	});
});

describe("ownership enforcement for sensitive actions", () => {
	beforeEach(() => {
		process.env.OPENAI_API_KEY = "test-key";
	});

	it("returns session_not_found for function_approve when wallet-bound session omits user_address", async () => {
		createSession(
			"session-approve-no-user",
			"thread-approve-no-user",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_approve",
			session_id: "session-approve-no-user",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for function_approve when wallet-bound session mismatches", async () => {
		createSession(
			"session-approve-mismatch",
			"thread-approve-mismatch",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_approve",
			session_id: "session-approve-mismatch",
			user_address: "wallet-2",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for function_result when wallet-bound session omits user_address", async () => {
		createSession(
			"session-result-no-user",
			"thread-result-no-user",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_result",
			session_id: "session-result-no-user",
			tx_signature: "signature-no-user",
			status: "confirmed",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for function_result when wallet-bound session mismatches", async () => {
		createSession(
			"session-result-mismatch",
			"thread-result-mismatch",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_result",
			session_id: "session-result-mismatch",
			tx_signature: "signature-mismatch",
			status: "confirmed",
			user_address: "wallet-2",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for function_reject when wallet-bound session omits user_address", async () => {
		createSession(
			"session-reject-no-user",
			"thread-reject-no-user",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_reject",
			session_id: "session-reject-no-user",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});

	it("returns session_not_found for function_reject when wallet-bound session mismatches", async () => {
		createSession(
			"session-reject-mismatch",
			"thread-reject-mismatch",
			"wallet-1",
		);

		const response = await proxyAgenticChat({
			type: "function_reject",
			session_id: "session-reject-mismatch",
			user_address: "wallet-2",
			reason: "test",
		});

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe("session_not_found");
	});
});

describe("Wave 3 chat transfer policy gateway gating", () => {
	beforeEach(() => {
		mockTransferRuntimePrechecks();
		process.env.WALLET_SAFETY_ATTESTOR_SECRET_KEY = JSON.stringify(
			Array.from(web3.Keypair.generate().secretKey),
		);
		vi.spyOn(web3.Connection.prototype, "getLatestBlockhash").mockResolvedValue(
			{
				blockhash: "11111111111111111111111111111111",
				lastValidBlockHeight: 123,
			},
		);
		vi.mocked(transferGateway.evaluateTransferGateway).mockReset();
		vi.mocked(transferGateway.verifyTransferGatewayMetadata).mockReset();
		vi.mocked(transferGateway.buildTransferAuditEvent).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks policy DENY before creating a transfer proposal", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(COMPASS_DECISIONS.DENY, {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: "policy_denied",
				reasonCodes: ["TRANSFER_BLOCKED_RECIPIENT"],
				evaluatedRules: ["transfers.blocked_recipients"],
			}) as never,
		);

		const response = await requestDirectTransfer("session-wave3-policy-deny");

		expect(response.status).toBe(200);
		const events = parseSseEvents(await response.text());
		expect(transferGateway.evaluateTransferGateway).toHaveBeenCalledTimes(1);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "error",
					data: expect.objectContaining({
						code: expect.stringContaining("policy"),
						reason_codes: expect.arrayContaining([
							"TRANSFER_BLOCKED_RECIPIENT",
						]),
					}),
				}),
			]),
		);
		expect(events.some((event) => event.event === "proposal")).toBe(false);
		expect(getSession("session-wave3-policy-deny")?.pendingProposal).toBeNull();
	});

	it("fails closed on REQUIRE_ADDITIONAL_CONTEXT without creating a proposal", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(
				COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
				{
					proposalEligible: false,
					requiresApprovalCard: false,
					failClosedReason: "policy_requires_additional_context",
					reasonCodes: ["TRANSFER_MISSING_AMOUNT"],
					evaluatedRules: ["transfers.require_amount_usd"],
				},
			) as never,
		);

		const response = await requestDirectTransfer(
			"session-wave3-policy-context",
		);

		expect(response.status).toBe(200);
		const events = parseSseEvents(await response.text());
		expect(transferGateway.evaluateTransferGateway).toHaveBeenCalledTimes(1);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "error",
					data: expect.objectContaining({
						code: expect.stringContaining("policy"),
						reason_codes: expect.arrayContaining(["TRANSFER_MISSING_AMOUNT"]),
					}),
				}),
			]),
		);
		expect(events.some((event) => event.event === "proposal")).toBe(false);
		expect(
			getSession("session-wave3-policy-context")?.pendingProposal,
		).toBeNull();
	});

	it("fails closed on future unhandled policy decisions before proposal creation", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(COMPASS_DECISIONS.REQUIRE_SIMULATION, {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: "policy_requires_simulation",
				reasonCodes: ["TRANSFER_REQUIRES_SIMULATION"],
				evaluatedRules: ["transfers.future_simulation_rule"],
			}) as never,
		);

		const response = await requestDirectTransfer("session-wave3-policy-future");

		expect(response.status).toBe(200);
		const events = parseSseEvents(await response.text());
		expect(transferGateway.evaluateTransferGateway).toHaveBeenCalledTimes(1);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "error",
					data: expect.objectContaining({
						code: expect.stringContaining("policy"),
						reason_codes: expect.arrayContaining([
							"TRANSFER_REQUIRES_SIMULATION",
						]),
					}),
				}),
			]),
		);
		expect(events.some((event) => event.event === "proposal")).toBe(false);
		expect(
			getSession("session-wave3-policy-future")?.pendingProposal,
		).toBeNull();
	});

	it("keeps ALLOW transfer behind approval card instead of auto-executing", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(COMPASS_DECISIONS.ALLOW, {
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}) as never,
		);

		const response = await requestDirectTransfer("session-wave3-policy-allow");

		expect(response.status).toBe(200);
		const events = parseSseEvents(await response.text());
		const pendingProposal = getSession(
			"session-wave3-policy-allow",
		)?.pendingProposal;

		expect(transferGateway.evaluateTransferGateway).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.event === "proposal")).toBe(true);
		expect(events.some((event) => event.event === "error")).toBe(false);
		expect(pendingProposal).toMatchObject({
			proposalType: "transfer",
			state: "awaiting_approval",
			toolName: "transfer",
		});
		expect(pendingProposal?.recentBlockhash).toBeUndefined();
		expect(pendingProposal?.txSignature).toBeUndefined();
	});

	it("creates the existing approval proposal for REQUIRE_HUMAN_APPROVAL", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(
				COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
				{
					reasonCodes: ["TRANSFER_UNKNOWN_RECIPIENT"],
					evaluatedRules: ["transfers.require_approval_for_unknown_recipient"],
				},
			) as never,
		);

		const response = await requestDirectTransfer("session-wave3-policy-human");

		expect(response.status).toBe(200);
		const events = parseSseEvents(await response.text());
		const pendingProposal = getSession(
			"session-wave3-policy-human",
		)?.pendingProposal;

		expect(transferGateway.evaluateTransferGateway).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.event === "proposal")).toBe(true);
		expect(pendingProposal).toMatchObject({
			proposalType: "transfer",
			state: "awaiting_approval",
			toolName: "transfer",
		});
		expect(pendingProposal?.recentBlockhash).toBeUndefined();
		expect(pendingProposal?.txSignature).toBeUndefined();
	});

	it("fails closed during approval when Wave 3 transfer gateway metadata is missing", async () => {
		const sessionId = "session-wave3-approval-missing-gateway";
		await createApprovalReadyWave3TransferProposal(sessionId);
		const session = getSession(sessionId)!;
		session.pendingProposal = {
			...session.pendingProposal!,
			transferGatewayMetadata: undefined,
		};
		vi.mocked(
			transferGateway.verifyTransferGatewayMetadata,
		).mockReturnValueOnce({
			ok: false,
			reason: "gateway_context_missing",
		});

		const response = await requestTransferApproval(sessionId);
		const body = await response.json();

		expect(transferGateway.verifyTransferGatewayMetadata).toHaveBeenCalledTimes(
			1,
		);
		expect(web3.Connection.prototype.getLatestBlockhash).not.toHaveBeenCalled();
		expect(response.status).toBe(409);
		expect(body.error).toMatchObject({
			code: "gateway_context_missing",
		});
		expect(getSession(sessionId)?.pendingProposal?.state).toBe("failed");
		expect(
			getSession(sessionId)?.pendingProposal?.recentBlockhash,
		).toBeUndefined();
	});

	it("fails closed during approval when transfer gateway metadata fingerprint mismatches", async () => {
		const sessionId = "session-wave3-approval-gateway-mismatch";
		const pendingProposal =
			await createApprovalReadyWave3TransferProposal(sessionId);
		const session = getSession(sessionId)!;
		session.pendingProposal = {
			...pendingProposal,
			transferGatewayMetadata: {
				...pendingProposal.transferGatewayMetadata!,
				candidateFingerprint: "tampered-candidate-fingerprint",
				policyId: "tampered-policy-id",
			},
		};
		vi.mocked(
			transferGateway.verifyTransferGatewayMetadata,
		).mockReturnValueOnce({
			ok: false,
			reason: "gateway_metadata_mismatch",
			mismatchedFields: ["candidateFingerprint", "policyId"],
		});

		const response = await requestTransferApproval(sessionId);
		const body = await response.json();

		expect(transferGateway.verifyTransferGatewayMetadata).toHaveBeenCalledTimes(
			1,
		);
		expect(web3.Connection.prototype.getLatestBlockhash).not.toHaveBeenCalled();
		expect(response.status).toBe(409);
		expect(body.error).toMatchObject({
			code: "gateway_metadata_mismatch",
		});
		expect(body.error.mismatched_fields).toEqual([
			"candidateFingerprint",
			"policyId",
		]);
		expect(getSession(sessionId)?.pendingProposal?.state).toBe("failed");
		expect(
			getSession(sessionId)?.pendingProposal?.recentBlockhash,
		).toBeUndefined();
	});

	it("keeps existing action_hash mismatch protection ahead of unsigned transfer tx build", async () => {
		const sessionId = "session-wave3-approval-action-hash-mismatch";
		await createApprovalReadyWave3TransferProposal(sessionId);

		const response = await requestTransferApproval(sessionId, "0".repeat(64));
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.error).toMatchObject({
			code: "action_hash_mismatch",
		});
		expect(
			transferGateway.verifyTransferGatewayMetadata,
		).not.toHaveBeenCalled();
		expect(web3.Connection.prototype.getLatestBlockhash).not.toHaveBeenCalled();
		expect(getSession(sessionId)?.pendingProposal).toBeNull();
	});

	it("emits a proposal_created transfer audit event when policy allows proposal creation", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(COMPASS_DECISIONS.ALLOW, {
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}) as never,
		);

		const response = await requestDirectTransfer(
			"session-wave3-audit-proposal-created",
		);
		expect(response.status).toBe(200);
		await response.text();

		expect(getTransferAuditCall("proposal_created")).toEqual(
			expect.objectContaining({
				lifecycle: "proposal_created",
				approvalStatus: "pending",
				result: "pending",
				evaluation: expect.objectContaining({
					candidate: expect.objectContaining({
						id: "chat-transfer-candidate",
						actionKind: "transfer",
						actorWallet: chatPolicyUserWallet,
					}),
					policyEvaluation: expect.objectContaining({
						policyId: "default-conservative",
						decision: COMPASS_DECISIONS.ALLOW,
						reasonCodes: expect.arrayContaining([
							"TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT",
						]),
						evaluatedRules: expect.arrayContaining([
							"transfers.max_usd_without_approval",
						]),
					}),
				}),
				metadata: expect.objectContaining({
					source: "chat_transfer_proposal",
				}),
			}),
		);
	});

	it("emits a proposal_rejected transfer audit event with policy reasons for fail-closed policy decisions", async () => {
		vi.mocked(transferGateway.evaluateTransferGateway).mockResolvedValueOnce(
			buildMockTransferGatewayEvaluation(COMPASS_DECISIONS.DENY, {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: "policy_denied",
				reasonCodes: ["TRANSFER_BLOCKED_RECIPIENT"],
				evaluatedRules: ["transfers.blocked_recipients"],
			}) as never,
		);

		const response = await requestDirectTransfer(
			"session-wave3-audit-policy-rejected",
		);
		expect(response.status).toBe(200);
		await response.text();

		expect(getTransferAuditCall("proposal_rejected")).toEqual(
			expect.objectContaining({
				lifecycle: "proposal_rejected",
				approvalStatus: "not_required",
				result: "denied",
				evaluation: expect.objectContaining({
					policyEvaluation: expect.objectContaining({
						policyId: "default-conservative",
						decision: COMPASS_DECISIONS.DENY,
						reasonCodes: expect.arrayContaining(["TRANSFER_BLOCKED_RECIPIENT"]),
						evaluatedRules: expect.arrayContaining([
							"transfers.blocked_recipients",
						]),
					}),
				}),
				metadata: expect.objectContaining({
					failClosedReason: "policy_denied",
					policyReasonCodes: expect.arrayContaining([
						"TRANSFER_BLOCKED_RECIPIENT",
					]),
					evaluatedRules: expect.arrayContaining([
						"transfers.blocked_recipients",
					]),
				}),
			}),
		);
	});

	it("emits approval_received and unsigned_tx_prepared audit events without raw tx bytes before wallet signing", async () => {
		const sessionId = "session-wave3-audit-approval";
		await createApprovalReadyWave3TransferProposal(sessionId);
		vi.mocked(
			transferGateway.verifyTransferGatewayMetadata,
		).mockReturnValueOnce({ ok: true });

		const response = await requestTransferApproval(sessionId);
		expect(response.status).toBe(200);

		expect(getTransferAuditCall("approval_received")).toEqual(
			expect.objectContaining({
				lifecycle: "approval_received",
				approvalStatus: "approved",
				result: "pending",
				metadata: expect.not.objectContaining({
					rawUnsignedTx: expect.any(String),
					unsigned_tx_base64: expect.any(String),
					signedTxBytes: expect.any(String),
				}),
			}),
		);
		expect(getTransferAuditCall("unsigned_tx_prepared")).toEqual(
			expect.objectContaining({
				lifecycle: "unsigned_tx_prepared",
				approvalStatus: "approved",
				result: "pending",
				metadata: expect.not.objectContaining({
					rawUnsignedTx: expect.any(String),
					unsigned_tx_base64: expect.any(String),
					signedTxBytes: expect.any(String),
				}),
			}),
		);
	});

	it("emits a user_rejected transfer audit event when the user rejects the pending proposal", async () => {
		const sessionId = "session-wave3-audit-user-rejected";
		await createApprovalReadyWave3TransferProposal(sessionId);

		const response = await proxyAgenticChat({
			type: "function_reject",
			session_id: sessionId,
			user_address: chatPolicyUserWallet,
			reason: "No quiero enviar fondos ahora",
		});

		expect(response.status).toBe(200);
		expect(getTransferAuditCall("user_rejected")).toEqual(
			expect.objectContaining({
				lifecycle: "user_rejected",
				approvalStatus: "rejected",
				result: "denied",
				metadata: expect.objectContaining({
					rejectionReason: "user_provided_reason",
				}),
			}),
		);
	});

	it("does not store freeform result errors in transfer audit metadata", async () => {
		const sessionId = "session-wave3-audit-result-failed-redaction";
		await createApprovalReadyWave3TransferProposal(sessionId);

		const response = await proxyAgenticChat({
			type: "function_result",
			session_id: sessionId,
			user_address: chatPolicyUserWallet,
			tx_signature: "tx-wave3-audit-failed",
			status: "failed",
			error_message:
				"raw prompt leaked private key and unsigned_tx_base64 payload",
		});

		expect(response.status).toBe(200);
		const auditCall = getTransferAuditCall("result_failed");
		expect(auditCall).toEqual(
			expect.objectContaining({
				lifecycle: "result_failed",
				result: "failed",
				metadata: expect.objectContaining({
					status: "failed",
					hasErrorMessage: true,
				}),
			}),
		);
		expect(auditCall?.metadata).not.toHaveProperty("errorMessage");
	});

	it("emits transfer result audit events when the frontend reports transaction status", async () => {
		const sessionId = "session-wave3-audit-result-submitted";
		await createApprovalReadyWave3TransferProposal(sessionId);

		const response = await proxyAgenticChat({
			type: "function_result",
			session_id: sessionId,
			user_address: chatPolicyUserWallet,
			tx_signature: "tx-wave3-audit-submitted",
			status: "submitted",
		});

		expect(response.status).toBe(200);
		expect(getTransferAuditCall("result_submitted")).toEqual(
			expect.objectContaining({
				lifecycle: "result_submitted",
				approvalStatus: "approved",
				result: "submitted",
				transactionSignature: "tx-wave3-audit-submitted",
				metadata: expect.objectContaining({
					status: "submitted",
				}),
			}),
		);
	});
});

describe("normalizeMessages", () => {
	it("normalizes valid messages array", () => {
		const input = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		];
		const result = normalizeMessages(input);
		expect(result).toHaveLength(2);
		expect(result![0].role).toBe("user");
		expect(result![1].role).toBe("assistant");
	});

	it("returns null for empty array", () => {
		expect(normalizeMessages([])).toBeNull();
	});

	it("returns null for missing content", () => {
		const input = [{ role: "user" }];
		expect(normalizeMessages(input)).toBeNull();
	});

	it("returns null for non-array input", () => {
		expect(normalizeMessages("not an array")).toBeNull();
		expect(normalizeMessages(null)).toBeNull();
		expect(normalizeMessages(undefined)).toBeNull();
	});
});

describe("Solana address masking", () => {
	it("masks valid Solana addresses before sending text to the model and restores tool args", () => {
		const recipient = "bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp";
		const masked = maskSolanaAddressesForModel(`Manda 5 SOL a ${recipient}`);

		expect(masked.content).toBe("Manda 5 SOL a SOLANA_ADDRESS_1");
		expect(masked.addressByPlaceholder.SOLANA_ADDRESS_1).toBe(recipient);

		const restored = restoreMaskedSolanaAddressesInToolArgs(
			'{"amount":5,"token":"SOL","recipient":"SOLANA_ADDRESS_1"}',
			masked.addressByPlaceholder,
		);
		expect(restored).toBe(
			`{"amount":5,"token":"SOL","recipient":"${recipient}"}`,
		);
	});

	it("masks address-like Solana strings even when they are malformed", () => {
		const malformedRecipient = "iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq";
		const masked = maskSolanaAddressesForModel(
			`Manda 1 SOL ${malformedRecipient}`,
		);

		expect(masked.content).toBe("Manda 1 SOL SOLANA_ADDRESS_1");
		expect(masked.addressByPlaceholder.SOLANA_ADDRESS_1).toBe(
			malformedRecipient,
		);
	});
});

describe("parseDirectTransferIntent", () => {
	it("parses simple transfer requests without requiring the model", () => {
		const recipient = "bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp";
		const parsed = parseDirectTransferIntent(`Manda 1 SOL ${recipient}`);

		expect(parsed).toMatchObject({
			matched: true,
			amount: 1,
			token: "SOL",
			recipient,
			recipientValid: true,
		});
	});

	it("detects malformed recipient addresses before calling the model", () => {
		const parsed = parseDirectTransferIntent(
			"Manda 1 SOL iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq",
		);

		expect(parsed).toMatchObject({
			matched: true,
			amount: 1,
			token: "SOL",
			recipientValid: false,
		});
	});

	it("normalizes common SOL typos in direct transfer requests", () => {
		const recipient = "iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq2";
		const parsed = parseDirectTransferIntent(`Manda 15 sola. ${recipient}`);

		expect(parsed).toMatchObject({
			matched: true,
			amount: 15,
			token: "SOL",
			recipient,
			recipientValid: true,
		});
	});
});

describe("prepareTransferResult", () => {
	const validFromWallet = "11111111111111111111111111111111";
	const validToWallet = "So11111111111111111111111111111111111111112";

	it("prepares transfer for valid params", () => {
		const result = prepareTransferResult(
			{ amount: 0.25, token: "SOL", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("prepared");
		expect(result.preparedAction?.executedOnChain).toBe(false);
		expect(result.preparedAction?.requiresUserSignature).toBe(true);
		expect(result.preparedAction?.fromWallet).toBe(validFromWallet);
		expect(result.preparedAction?.toWallet).toBe(validToWallet);
	});

	it("denies invalid source wallet", () => {
		const result = prepareTransferResult(
			{ amount: 0.25, token: "SOL", recipient: validToWallet },
			"not-a-wallet",
		);

		expect(result.status).toBe("denied");
		expect(result.reason).toBe("INVALID_FROM_WALLET");
	});

	it("denies invalid recipient", () => {
		const result = prepareTransferResult(
			{ amount: 0.25, token: "SOL", recipient: "not-a-wallet" },
			validFromWallet,
		);

		expect(result.status).toBe("denied");
		expect(result.reason).toBe("INVALID_RECIPIENT");
	});

	it("denies non-positive amount", () => {
		const result = prepareTransferResult(
			{ amount: 0, token: "SOL", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("denied");
		expect(result.reason).toBe("INVALID_AMOUNT");
	});

	it("denies negative amount", () => {
		const result = prepareTransferResult(
			{ amount: -1, token: "SOL", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("denied");
		expect(result.reason).toBe("INVALID_AMOUNT");
	});

	it("defaults token to SOL", () => {
		const result = prepareTransferResult(
			{ amount: 1, token: "", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("prepared");
		expect(result.preparedAction?.token).toBe("SOL");
	});

	it("normalizes SOLA typo to SOL", () => {
		const result = prepareTransferResult(
			{ amount: 1, token: "sola", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("prepared");
		expect(result.preparedAction?.token).toBe("SOL");
	});

	it("denies unsupported tokens before creating a transfer proposal", () => {
		const result = prepareTransferResult(
			{ amount: 1, token: "USDC", recipient: validToWallet },
			validFromWallet,
		);

		expect(result.status).toBe("denied");
		expect(result.reason).toBe("UNSUPPORTED_TOKEN");
	});

	it("includes memo when provided", () => {
		const result = prepareTransferResult(
			{ amount: 1, token: "SOL", recipient: validToWallet, memo: "Test memo" },
			validFromWallet,
		);

		expect(result.status).toBe("prepared");
		expect(result.preparedAction?.memo).toBe("Test memo");
	});
});

describe("evaluateSolTransferFunding", () => {
	it("denies a SOL transfer when balance cannot cover amount and guardrail overhead", () => {
		const result = evaluateSolTransferFunding({
			balanceLamports: 5_000_000_000,
			amountLamports: 5_000_000_000,
			policyRentLamports: 1_000_000,
			approvalRentLamports: 2_000_000,
			feeBufferLamports: 50_000,
			policyAccountMissing: true,
		});

		expect(result.ok).toBe(false);
		expect(result.requiredLamports).toBe(5_003_050_000);
		expect(result.missingLamports).toBe(3_050_000);
	});

	it("does not include policy rent when the wallet policy already exists", () => {
		const result = evaluateSolTransferFunding({
			balanceLamports: 5_002_050_000,
			amountLamports: 5_000_000_000,
			policyRentLamports: 1_000_000,
			approvalRentLamports: 2_000_000,
			feeBufferLamports: 50_000,
			policyAccountMissing: false,
		});

		expect(result.ok).toBe(true);
		expect(result.requiredLamports).toBe(5_002_050_000);
		expect(result.overheadLamports).toBe(2_050_000);
	});
});
