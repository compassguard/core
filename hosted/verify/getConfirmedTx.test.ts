import { describe, expect, it, vi } from "vitest";

import { createBoundedConfirmedTxFetcher, type ConfirmedTx } from "./getConfirmedTx";

const okTx = { meta: { err: null } } as unknown as ConfirmedTx;
const errTx = { meta: { err: "InstructionError" } } as unknown as ConfirmedTx;

// Mock clock advanced by the injected sleep, so the wait budget is deterministic.
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

describe("createBoundedConfirmedTxFetcher", () => {
	it("returns the tx once it is confirmed", async () => {
		const clock = fakeClock();
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 3000,
			pollIntervalMs: 100,
			perCallTimeoutMs: 100,
			fetchOnce: async () => okTx,
		});
		expect(await fetch("sig")).toBe(okTx);
	});

	it("returns null after the wait budget with no confirmation", async () => {
		const clock = fakeClock();
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 3000,
			pollIntervalMs: 100,
			perCallTimeoutMs: 100,
			fetchOnce: async () => null,
		});
		expect(await fetch("sig")).toBeNull();
	});

	it("treats a throwing RPC call as not-yet-confirmed and never lets it escape (F50)", async () => {
		const clock = fakeClock();
		const fetchOnce = vi.fn(async () => {
			throw new Error("rpc down");
		});
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 2000,
			pollIntervalMs: 100,
			perCallTimeoutMs: 100,
			fetchOnce,
		});
		expect(await fetch("sig")).toBeNull();
		expect(fetchOnce).toHaveBeenCalled();
	});

	it("returns a confirmed-but-failed (meta.err) tx immediately, without exhausting the budget (D9-v2)", async () => {
		const clock = fakeClock();
		let calls = 0;
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 3000,
			pollIntervalMs: 100,
			perCallTimeoutMs: 100,
			fetchOnce: async () => {
				calls += 1;
				return errTx;
			},
		});
		// A finalized-failed signature is terminal: it short-circuits the poll (the
		// confirm service inspects meta.err), rather than being re-polled to the budget end.
		expect(await fetch("sig")).toBe(errTx);
		expect(calls).toBe(1);
	});

	it("bounds total wall-clock to maxWaitMs even when a fetch starts just before the deadline (D10)", async () => {
		const clock = fakeClock();
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 150,
			pollIntervalMs: 0, // isolate the per-call bound: only fetch waits move the clock
			perCallTimeoutMs: 100,
			fetchOnce: async () => null,
		});
		// deadline = 150. The second fetch begins at t=100 with only 50 of budget left, so
		// it is capped at 50 (min(100, remaining)) and ends exactly at the deadline — the old
		// code let it run a full perCallTimeoutMs (to t=200), overshooting maxWaitMs.
		expect(await fetch("sig")).toBeNull();
		expect(clock.now()).toBeLessThanOrEqual(150);
	});
});
