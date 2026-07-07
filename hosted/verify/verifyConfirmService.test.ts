import { describe, expect, it, vi } from "vitest";

import type { DeriveActualEffect, IntendedEffect } from "@shared/verdictContracts";
import {
	createInMemoryVerdictStore,
	type DecidedInput,
	type VerdictStore,
} from "../verdict/verdictStore";
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

	it("returns execution_failed and closes CONFIRMED_MISMATCH for a confirmed-but-failed tx (#4)", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const failedTx = { meta: { err: "InstructionError" } } as unknown as ConfirmedTx;
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: async () => failedTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("execution_failed");
		expect(res.discrepancies).toEqual([]);
		const stored = await store.getByCorrelationId("c1");
		expect(stored?.status).toBe("CONFIRMED_MISMATCH");
		expect(stored?.txSignature).toBe("sig");
	});

	it("returns error (never a fabricated mismatch) when an already_closed record is missing (#5)", async () => {
		// A store whose claim says already_closed but has no record — the exact absence the
		// old `?? "mismatch"` fabricated a verdict for. outcomeFromRecord fails closed to error.
		const store: VerdictStore = {
			putDecided: async () => {},
			getByCorrelationId: async () => undefined,
			claim: async () => "already_closed",
			release: async () => {},
			closeOutcome: async () => undefined,
			list: async () => [],
		};
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		const res = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig" });
		expect(res.outcome).toBe("error");
		expect(res.discrepancies).toEqual([]);
	});

	it("derives the success response from the record the store persisted (#6)", async () => {
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
		const stored = await store.getByCorrelationId("c1");
		expect(stored?.status).toBe("CONFIRMED_MISMATCH");
		expect(res.outcome).toBe("mismatch");
		// The HTTP response cannot diverge from what the store persisted.
		expect(res.discrepancies).toEqual(stored?.discrepancies);
	});

	it("persists the confirming txSignature on the closed record (#14a)", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		await svc.verifyConfirm({ correlationId: "c1", txSignature: "sig-xyz" });
		expect((await store.getByCorrelationId("c1"))?.txSignature).toBe("sig-xyz");
	});

	it("flags signature_mismatch when a closed correlation is re-confirmed with a different signature (#14b)", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		const svc = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});

		const first = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sigA" });
		expect(first.outcome).toBe("match");

		// same signature → cached verdict (idempotent, unchanged)
		const sameSig = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sigA" });
		expect(sameSig.outcome).toBe("match");

		// a DIFFERENT signature for the already-closed correlation → flagged, not a stale match
		const diffSig = await svc.verifyConfirm({ correlationId: "c1", txSignature: "sigB" });
		expect(diffSig.outcome).toBe("signature_mismatch");
	});
});
