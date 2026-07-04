import { describe, expect, it, vi } from "vitest";

import type { DeriveActualEffect, IntendedEffect } from "@shared/verdictContracts";
import { createInMemoryVerdictStore, type DecidedInput } from "../verdict/verdictStore";
import type { ConfirmedTx } from "./getConfirmedTx";
import { createVerifyConfirmService } from "./verifyConfirmService";

const INTENDED: IntendedEffect = {
	actionKind: "transfer",
	recipient: "RcpT111",
	lamports: 25_000_000,
};

function decided(correlationId: string): DecidedInput {
	return {
		correlationId,
		decision: "review",
		reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
		humanExplanation: "Recipient is not on the allowlist.",
		intendedEffect: INTENDED,
		decidedAt: "2026-07-03T00:00:00.000Z",
	};
}

const FAKE_TX = {} as ConfirmedTx;
const gotTx = async () => FAKE_TX;
const noTx = async () => null;
const matchDecoder: DeriveActualEffect = () => ({
	unavailable: false,
	recipient: "RcpT111",
	lamports: 25_000_000,
	extraInstructions: [],
});
const unavailableDecoder: DeriveActualEffect = () => ({ unavailable: true });

describe("createVerifyConfirmService", () => {
	it("returns unknown_correlation for an unseen id", async () => {
		const store = createInMemoryVerdictStore();
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "nope", txSignature: "sig" });
		expect(res.outcome).toBe("unknown_correlation");
	});

	it("returns unconfirmed and leaves the record retryable (DECIDED) on no tx", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: noTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("unconfirmed");
		expect((await store.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("returns unverified_no_decoder (and releases) when no real decoder is injected", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: unavailableDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("unverified_no_decoder");
		expect((await store.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("closes CONFIRMED_MATCH when the actual effect matches", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("match");
		expect((await store.getByCorrelationId("c1"))?.status).toBe("CONFIRMED_MATCH");
	});

	it("catches a mismatch (extra instruction) and records it", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const divergent: DeriveActualEffect = () => ({
			unavailable: false,
			recipient: "RcpT111",
			lamports: 25_000_000,
			extraInstructions: ["SetAuthority"],
		});
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: divergent,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("mismatch");
		expect(res.discrepancies).toEqual([
			{ field: "extra_instruction", actual: "SetAuthority" },
		]);
		expect((await store.getByCorrelationId("c1"))?.status).toBe("CONFIRMED_MISMATCH");
	});

	it("is idempotent — a repeat returns the cached outcome without re-fetching", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const getConfirmedTx = vi.fn(gotTx);
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx,
			deriveActualEffect: matchDecoder,
		});

		const first = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		const second = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(first.outcome).toBe("match");
		expect(second.outcome).toBe("match");
		expect(getConfirmedTx).toHaveBeenCalledOnce(); // no second chain hit
	});

	it("returns pending when another confirm holds the lease", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		await store.claim("c1"); // simulate a concurrent confirm in flight
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("pending");
	});
});
