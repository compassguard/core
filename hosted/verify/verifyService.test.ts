import { describe, expect, it, vi } from "vitest";

import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { createInMemoryMandateStore } from "../mandate/mandateStore";
import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import { createVerifyService } from "./verifyService";
import type { VerdictStore } from "../verdict/verdictStoreTypes";
import type { VerifyJudgeResult } from "./verifyJudge";

describe("createVerifyService", () => {
	it("allows a read-only tool (balance) and records a DECIDED verdict", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({ verdictStore: store });

		const res = await service.verifyAction({ toolName: "get_wallet_holdings" });

		expect(res.decision).toBe("allow");
		expect(res.correlationId).toBeTruthy();
		expect(res.humanExplanation).toBeTruthy();
		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.status).toBe("DECIDED");
		expect(record?.intendedEffect.actionKind).toBe("unknown");
	});

	it("denies a transfer that changes authority (deterministic flag)", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({ verdictStore: store });

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			arguments: {
				recipient: "RcpT111",
				amountUsd: 5,
				authority_change: true,
			},
		});

		expect(res.decision).toBe("deny");
		expect(res.reasons).toContain("BLOCKED_AUTHORITY_CHANGE");
		expect(res.humanExplanation).toMatch(/authority/i);
	});

	it("routes an over-cap / unknown-recipient transfer to review", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({ verdictStore: store });

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			arguments: { recipient: "Stranger", amountUsd: 999 },
		});

		expect(res.decision).toBe("review");
		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.intendedEffect.recipient).toBe("Stranger");
		expect(record?.intendedEffect.amountUsd).toBe(999);
	});

	it("server-stamps decidedAt via isoNow when requestedAt is omitted (D11 / #12)", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({
			verdictStore: store,
			isoNow: () => "2026-07-07T12:00:00.000Z",
		});

		const res = await service.verifyAction({ toolName: "get_wallet_holdings" });

		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.decidedAt).toBe("2026-07-07T12:00:00.000Z");
	});

	it("attributes the verdict to the caller's authenticatedEmail (D11)", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({ verdictStore: store });

		const res = await service.verifyAction(
			{ toolName: "get_wallet_holdings" },
			{ authenticatedEmail: "x@y.z" },
		);

		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.authenticatedEmail).toBe("x@y.z");
	});

	it("returns the verdict even when the DECIDED write fails (stateless verdict)", async () => {
		const throwingStore = {
			putDecided: vi.fn().mockRejectedValue(new Error("store down")),
		} as unknown as VerdictStore;
		const captureException = vi.fn();
		const service = createVerifyService({
			verdictStore: throwingStore,
			captureException,
		});

		const res = await service.verifyAction({ toolName: "get_wallet_holdings" });

		expect(res.decision).toBe("allow"); // verdict unaffected by the write failure
		expect(captureException).toHaveBeenCalledOnce();
	});

	const MANDATE_DEPS = async (judgeResult: VerifyJudgeResult) => {
		const mandateStore = createInMemoryMandateStore();
		await mandateStore.put({
			ownerId: "alice@example.com",
			mandateText: "Only pay approved vendors.",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});
		const verifyJudge = vi.fn(async () => judgeResult);
		return { mandateStore, verifyJudge };
	};

	it("keeps intentSource none and behaves exactly as before when no judge is wired", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({ verdictStore: store });

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer", statedPurpose: "pay vendor Acme" },
			arguments: { recipient: "RcpT111", amountUsd: 5 },
		});

		expect(res.intentSource).toBe("none");
		expect(res.reasons).not.toContain("judge_unavailable");
	});

	it("judges with mandate + statedPurpose: tightened decision, merged reasons, self_report", async () => {
		const store = createInMemoryVerdictStore();
		const { mandateStore, verifyJudge } = await MANDATE_DEPS({
			ran: true,
			decision: COMPASS_DECISIONS.DENY,
			clamped: true,
			reasonCodes: ["off_mandate_recipient"],
			rationale: "Recipient is not part of the owner's mandate.",
		});
		const service = createVerifyService({ verdictStore: store, mandateStore, verifyJudge });

		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "pay vendor Acme invoice #42" },
				arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
				userId: "ignored-when-email-present",
			},
			{ authenticatedEmail: "alice@example.com" },
		);

		expect(res.decision).toBe("deny");
		expect(res.intentSource).toBe("self_report");
		expect(res.reasons).toContain("off_mandate_recipient");
		expect(res.humanExplanation).toMatch(/mandate judge/i);
		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.intentSource).toBe("self_report");
		expect(record?.judgeRationale).toMatch(/owner's mandate/);
		expect(verifyJudge).toHaveBeenCalledWith(
			expect.objectContaining({
				statedPurpose: "pay vendor Acme invoice #42",
				deterministicDecision: COMPASS_DECISIONS.ALLOW,
			}),
		);
	});

	it("never consults the judge on a deterministic DENY (Tier-1 is final)", async () => {
		const store = createInMemoryVerdictStore();
		const { mandateStore, verifyJudge } = await MANDATE_DEPS({ ran: false });
		const service = createVerifyService({ verdictStore: store, mandateStore, verifyJudge });

		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "pay vendor" },
				arguments: { recipient: "RcpT111", amountUsd: 5, authority_change: true },
			},
			{ authenticatedEmail: "alice@example.com" },
		);

		expect(res.decision).toBe("deny");
		expect(res.intentSource).toBe("none");
		expect(verifyJudge).not.toHaveBeenCalled();
	});

	it("skips the judge without judge_unavailable noise when no mandate is registered", async () => {
		const store = createInMemoryVerdictStore();
		const mandateStore = createInMemoryMandateStore();
		const verifyJudge = vi.fn(async (): Promise<VerifyJudgeResult> => ({ ran: false }));
		const service = createVerifyService({ verdictStore: store, mandateStore, verifyJudge });

		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "pay vendor" },
				arguments: { recipient: "RcpT111", amountUsd: 5 },
			},
			{ authenticatedEmail: "nobody@example.com" },
		);

		expect(res.intentSource).toBe("none");
		expect(res.reasons).not.toContain("judge_unavailable");
		expect(verifyJudge).not.toHaveBeenCalled();
	});

	it("appends judge_unavailable (fail-honest) when the judge should run but cannot", async () => {
		const store = createInMemoryVerdictStore();
		const { mandateStore, verifyJudge } = await MANDATE_DEPS({ ran: false });
		const service = createVerifyService({ verdictStore: store, mandateStore, verifyJudge });

		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "pay vendor" },
				arguments: { recipient: "RcpT111", amountUsd: 5 },
			},
			{ authenticatedEmail: "alice@example.com" },
		);

		expect(res.intentSource).toBe("none");
		expect(res.reasons).toContain("judge_unavailable");
	});

	it("treats a mandate-store failure as no-mandate (captured, never a 500)", async () => {
		const store = createInMemoryVerdictStore();
		const captureException = vi.fn();
		const failingMandateStore = {
			put: async () => undefined,
			get: async () => {
				throw new Error("db down");
			},
		};
		const verifyJudge = vi.fn(async (): Promise<VerifyJudgeResult> => ({ ran: false }));
		const service = createVerifyService({
			verdictStore: store,
			mandateStore: failingMandateStore,
			verifyJudge,
			captureException,
		});

		const res = await service.verifyAction(
			{
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "pay vendor" },
				arguments: { recipient: "RcpT111", amountUsd: 5 },
			},
			{ authenticatedEmail: "alice@example.com" },
		);

		expect(res.intentSource).toBe("none");
		expect(captureException).toHaveBeenCalled();
		expect(verifyJudge).not.toHaveBeenCalled();
	});
});
