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

	it("keeps polling past a failed (meta.err) tx until a good one confirms", async () => {
		const clock = fakeClock();
		let calls = 0;
		const fetch = createBoundedConfirmedTxFetcher({
			...clock,
			maxWaitMs: 3000,
			pollIntervalMs: 100,
			perCallTimeoutMs: 100,
			fetchOnce: async () => {
				calls += 1;
				return calls >= 2 ? okTx : errTx;
			},
		});
		expect(await fetch("sig")).toBe(okTx);
	});
});
