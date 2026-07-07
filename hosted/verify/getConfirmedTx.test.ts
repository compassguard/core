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

	it("bounds TOTAL wall-clock to maxWaitMs at the default pollIntervalMs, so the inter-poll sleep never overshoots the deadline (D10-v3/Fv2)", async () => {
		const clock = fakeClock();
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 2500,
			// Default pollIntervalMs (1000) — do NOT zero it: the inter-poll sleep after a
			// null fetch must itself be bounded by the remaining budget, not run a full
			// interval past the deadline.
			perCallTimeoutMs: 1000,
			fetchOnce: async () => null,
		});
		// deadline = 2500. Fetch #1 ends at t=1000 (capped 1000), then a bounded 1000ms sleep
		// to t=2000; fetch #2 is capped at the remaining 500 and ends exactly at t=2500 with 0
		// budget left. The old unbounded code then slept a full pollIntervalMs (to t=3500),
		// pushing total wall-clock to maxWaitMs + pollIntervalMs; the fix returns null at 0.
		expect(await fetch("sig")).toBeNull();
		expect(clock.now()).toBeLessThanOrEqual(2500);
	});
});
