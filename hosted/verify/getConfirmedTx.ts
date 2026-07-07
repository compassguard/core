import {
	getConnection,
	withThrottle,
} from "@back/services/solana/providers/solanaConnection";
import type { VersionedTransactionResponse } from "@solana/web3.js";

export type ConfirmedTx = VersionedTransactionResponse;

/** Bounded-wait fetch: returns the confirmed tx, or null if not confirmed in time. */
export type GetConfirmedTx = (txSignature: string) => Promise<ConfirmedTx | null>;

export type BoundedFetchOptions = {
	/** Total wait budget (~8s, under the D24 serverless maxDuration). */
	maxWaitMs?: number;
	/** Delay between polls. */
	pollIntervalMs?: number;
	/** Per-call deadline so one hung getTransaction can't defeat the bound (F50). */
	perCallTimeoutMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Single-shot fetch; defaults to the shared Solana connection. */
	fetchOnce?: (txSignature: string) => Promise<ConfirmedTx | null>;
};

/**
 * Poll getTransaction until the tx is confirmed or the wait budget is spent (D17).
 * A hung OR throwing RPC call is treated as "not yet confirmed" (F50) — it never
 * escapes as a 500 and never hangs past the per-call deadline.
 */
export function createBoundedConfirmedTxFetcher(
	options: BoundedFetchOptions = {},
): GetConfirmedTx {
	const maxWaitMs = options.maxWaitMs ?? 8000;
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	const perCallTimeoutMs = options.perCallTimeoutMs ?? 5000;
	const now = options.now ?? (() => Date.now());
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const fetchOnce =
		options.fetchOnce ??
		((txSignature: string) =>
			// Route the confirmed-tx fetch through the shared RPC throttle (100ms min
			// interval) rather than hitting getConnection() directly — the poll fires
			// repeated getTransaction calls and must not bypass the shared rate limiter.
			withThrottle(() =>
				getConnection().getTransaction(txSignature, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed",
				}),
			));

	return async (txSignature) => {
		const deadline = now() + maxWaitMs;
		for (;;) {
			// Bound the total wall-clock (D10/F13): never begin a fetch past the deadline,
			// and cap each fetch by the remaining budget so a call started just before the
			// deadline cannot overshoot by a full perCallTimeoutMs.
			const remaining = deadline - now();
			if (remaining <= 0) {
				return null;
			}
			let tx: ConfirmedTx | null = null;
			try {
				tx = await withTimeout(
					fetchOnce(txSignature),
					Math.min(perCallTimeoutMs, remaining),
				);
			} catch {
				tx = null; // hung/throwing RPC → not-yet-confirmed (F50)
			}
			// Any confirmed tx short-circuits the poll (D9-v2), even a failed one (meta.err):
			// a finalized signature is terminal. The confirm service inspects meta.err.
			if (tx) {
				return tx;
			}
			// Bound the inter-poll sleep by the remaining budget too (D10-v3/Fv2): a fetch that
			// returned null just before the deadline must not be followed by a full pollIntervalMs
			// sleep, or total wall-clock would reach maxWaitMs + pollIntervalMs. If nothing is
			// left, stop now (not-confirmed) rather than sleep past the deadline.
			const remainingAfterFetch = deadline - now();
			if (remainingAfterFetch <= 0) {
				return null;
			}
			await sleep(Math.min(pollIntervalMs, remainingAfterFetch));
		}
	};
}

// Real cancellable timer (the codebase's clearTimeout pattern): when the fetch wins the
// race the timeout is cleared, so no setTimeout lingers keeping the serverless instance
// warm up to perCallTimeoutMs after the function returns.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("rpc call timed out")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}) as Promise<T>;
}
