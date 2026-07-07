import { describe, expect, it, vi } from "vitest";

import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import { createVerifyService } from "./verifyService";
import type { VerdictStore } from "../verdict/verdictStore";

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
