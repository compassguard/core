import { describe, expect, it, vi } from "vitest";

import {
	TRUST_VERDICTS,
	type TrustProvider,
	type TrustSignal,
} from "@shared/trustContracts";

import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import { createVerifyService } from "./verifyService";
import type { VerdictStore } from "../verdict/verdictStoreTypes";

const fixedProvider = (signal: TrustSignal): TrustProvider => ({
	screen: () => Promise.resolve(signal),
});

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

	it("screening escalates an otherwise-allowed transfer to a sanctioned recipient into deny, and persists the signed evidence", async () => {
		const store = createInMemoryVerdictStore();
		const signed = { result: { sanctioned: true }, signature: "0xabc" };
		const service = createVerifyService({
			verdictStore: store,
			trustProvider: fixedProvider({
				verdict: TRUST_VERDICTS.SANCTIONED,
				reasons: [],
				evidence: signed,
			}),
		});

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			// Within cap + known recipient → the deterministic engine alone would allow.
			arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
		});

		expect(res.decision).toBe("deny");
		expect(res.reasons).toContain("COUNTERPARTY_SANCTIONED");
		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.decision).toBe("deny");
		expect(record?.evidence).toEqual(signed);
	});

	it("records screening-unavailable as review, distinct from a clean pass", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({
			verdictStore: store,
			trustProvider: fixedProvider({
				verdict: TRUST_VERDICTS.UNAVAILABLE,
				reasons: [],
			}),
		});

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
		});

		expect(res.decision).toBe("review");
		expect(res.reasons).toContain("COUNTERPARTY_SCREENING_UNAVAILABLE");
	});

	it("a clean screen leaves an allowed transfer allowed and stores no evidence", async () => {
		const store = createInMemoryVerdictStore();
		const service = createVerifyService({
			verdictStore: store,
			trustProvider: fixedProvider({
				verdict: TRUST_VERDICTS.CLEAN,
				reasons: [],
				evidence: { result: {} },
			}),
		});

		const res = await service.verifyAction({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			arguments: { recipient: "RcpT111", amountUsd: 5, recipientKnown: true },
		});

		expect(res.decision).toBe("allow");
		const record = await store.getByCorrelationId(res.correlationId);
		expect(record?.evidence).toBeUndefined();
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
});
