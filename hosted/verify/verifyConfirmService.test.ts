import { describe, expect, it, vi } from "vitest";

import type { DeriveActualEffect, IntendedEffect } from "@shared/verdictContracts";
import {
	createInMemoryVerdictStore,
	type DecidedInput,
	type VerdictRecord,
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

	it("returns unverified_no_decoder and leaves the record retryable (DECIDED) when no real decoder is injected", async () => {
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

	it("returns error (never a fabricated verdict) when closeOutcome resolves undefined — a store inconsistency (#5)", async () => {
		// Leaseless flow: getByCorrelationId returns a DECIDED record, the tx confirms and the
		// effect matches, but closeOutcome resolves undefined (a store inconsistency).
		// outcomeFromRecord(undefined) fails closed to `error` rather than fabricating a verdict.
		// The mock exposes only the four methods the leaseless service depends on (no
		// claim/release); the cast bridges the still-six-method VerdictStore type until U2 shrinks it.
		const decidedRecord: VerdictRecord = { ...decided("c1"), status: "DECIDED" };
		const store = {
			putDecided: async () => {},
			getByCorrelationId: async () => decidedRecord,
			closeOutcome: async () => undefined,
			list: async () => [],
		} as unknown as VerdictStore;
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

	it("under concurrent DIFFERENT-signature confirms, the close-race loser gets signature_mismatch, not the winner's verdict (#14b under concurrency, D12 guard)", async () => {
		// One store, two services whose decoders would yield DIVERGENT outcomes. Both read the
		// DECIDED record before either closes, then race on closeOutcome. The atomic
		// first-writer-wins close binds the record to exactly one signature; the loser's D12
		// guard sees a winner bound to another tx and returns signature_mismatch — NOT the
		// winner's outcome, NOT a fabricated verdict.
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));

		const mismatchDecoder: DeriveActualEffect = () => ({
			unavailable: false,
			recipient: "RcpT111",
			lamports: 25_000_000,
			extraInstructions: ["SetAuthority"],
		});
		const svcMatch = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: matchDecoder,
		});
		const svcMismatch = createVerifyConfirmService({
			verdictStore: store,
			getConfirmedTx: gotTx,
			deriveActualEffect: mismatchDecoder,
		});

		const [resA, resB] = await Promise.all([
			svcMatch.verifyConfirm({ correlationId: "c1", txSignature: "sigA" }),
			svcMismatch.verifyConfirm({ correlationId: "c1", txSignature: "sigB" }),
		]);

		// Exactly one response is signature_mismatch (the close-race loser).
		const mismatches = [resA, resB].filter(
			(r) => r.outcome === "signature_mismatch",
		);
		expect(mismatches).toHaveLength(1);

		// The winner is the other caller: it returns ITS OWN computed outcome, and the stored
		// record carries the winner's signature (never the loser's).
		const winner =
			resA.outcome !== "signature_mismatch"
				? { res: resA, sig: "sigA", expected: "match" as const }
				: { res: resB, sig: "sigB", expected: "mismatch" as const };
		expect(winner.res.outcome).toBe(winner.expected);
		expect((await store.getByCorrelationId("c1"))?.txSignature).toBe(winner.sig);
	});
});
