import {
	TRUST_VERDICTS,
	type TrustProvider,
	type TrustSignal,
} from "@shared/trustContracts";

/** No address to screen — screening did not apply. Imposes nothing. */
const NO_SIGNAL: TrustSignal = { verdict: TRUST_VERDICTS.NO_SIGNAL, reasons: [] };
/** The screen was attempted but could not complete. Imposes REVIEW (never a clean pass). */
const UNAVAILABLE: TrustSignal = {
	verdict: TRUST_VERDICTS.UNAVAILABLE,
	reasons: [],
};

export type NsgoodsProviderOptions = {
	baseUrl?: string;
	/**
	 * Chain the counterparty address lives on, passed to the endpoint. Compass is
	 * Solana-first, so this defaults to "solana"; the live endpoint otherwise
	 * defaults to ethereum and would screen a Solana address against the wrong
	 * chain's lists.
	 */
	chain?: string;
	/** Hard deadline for the whole screen() call, including the JSON read. */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	/**
	 * Verifies the provider's ECDSA signature over the payload. When supplied, a
	 * response that fails verification is discarded (NO_SIGNAL) rather than used.
	 *
	 * Note on why this is optional today: the signal is negative-evidence-only, so
	 * a forged response cannot relax a decision — the worst an attacker with a
	 * foothold on the wire could do is force *extra* caution (a denial-of-service,
	 * not a bypass). Verification is still the right end state, and the raw body
	 * is kept as evidence so a verdict remains independently auditable.
	 */
	verifySignature?: (body: unknown) => Promise<boolean>;
};

/** The live /screen response shape. Every field is optional on purpose. */
type ScreenResponseBody = {
	result?: {
		sanctioned?: boolean;
		malicious?: boolean;
		hard_flags?: unknown[];
		soft_flags?: unknown[];
	};
	/** Endpoint's own rollup: "deny" | "review" | "clean". Used only for the soft/review tier. */
	screening_verdict?: string;
};

/**
 * Adapter for the nsgoods counterparty-screening endpoint.
 *
 * Hardened against the two defects in the vendor's reference helper:
 *
 *   1. Never throws into the policy engine. The fetch, the status check and the
 *      JSON parse all sit inside the try, so a DNS failure, a timeout, or a 502
 *      HTML error page yields a verdict rather than an exception. (The reference
 *      helper only caught signature-recovery failures, so the failure mode that
 *      actually happens in production — the upstream being down — took the whole
 *      decision down with it.)
 *
 *   2. A hard deadline. This is a third party sitting in a decision path that is
 *      otherwise pure in-process compute, and the reference helper had no
 *      timeout at all. It is never allowed to hang.
 *
 * On any failure the screen returns UNAVAILABLE (not NO_SIGNAL): a screen we
 * could not complete escalates to REVIEW, so an outage never reads as a clean
 * pass — while still, by the negative-evidence-only invariant (applyTrustSignal),
 * never relaxing a decision. NO_SIGNAL is reserved for "no address to screen".
 *
 * The response shape tracks the live /screen endpoint (sanctioned / malicious /
 * hard_flags / soft_flags / screening_verdict). Only this file should need to
 * change if it evolves; the port and the invariant above it are stable.
 */
export function createNsgoodsTrustProvider(
	options: NsgoodsProviderOptions = {},
): TrustProvider {
	const baseUrl = options.baseUrl ?? "https://trust.nsgoods.org";
	const chain = options.chain ?? "solana";
	const timeoutMs = options.timeoutMs ?? 800;
	const doFetch = options.fetchImpl ?? fetch;

	return {
		async screen(counterpartyAddress: string): Promise<TrustSignal> {
			// No address to screen: screening does not apply. This is the ONLY no-op
			// path — every other early return below is UNAVAILABLE, because an
			// attempted-but-failed screen must not read as "checked, nothing found".
			if (counterpartyAddress.trim().length === 0) {
				return NO_SIGNAL;
			}

			try {
				const url = `${baseUrl}/screen?address=${encodeURIComponent(
					counterpartyAddress,
				)}&chain=${encodeURIComponent(chain)}`;
				const response = await withTimeout(doFetch(url), timeoutMs);
				if (!response.ok) {
					return UNAVAILABLE;
				}

				const body: unknown = JSON.parse(await response.text());

				if (options.verifySignature) {
					const verified = await options.verifySignature(body);
					if (!verified) {
						return UNAVAILABLE;
					}
				}

				return toTrustSignal(body);
			} catch {
				// Network error, timeout, or unparseable body: the screen was attempted
				// and could not complete → UNAVAILABLE (imposes REVIEW), never a
				// relaxation and never an exception into the policy engine. Deliberately
				// catch-all — a screening provider has no business deciding how a policy
				// engine handles its outages.
				return UNAVAILABLE;
			}
		},
	};
}

/** Map a /screen response to a verdict. Strongest negative wins. */
function toTrustSignal(body: unknown): TrustSignal {
	const parsed = body as ScreenResponseBody | null;
	const result = parsed?.result;
	if (!result) {
		// A 2xx whose body we cannot map to a verdict is a screen we could not
		// complete, NOT a clean pass: UNAVAILABLE (imposes REVIEW).
		return { verdict: TRUST_VERDICTS.UNAVAILABLE, reasons: [], evidence: body };
	}

	if (result.sanctioned === true) {
		return { verdict: TRUST_VERDICTS.SANCTIONED, reasons: [], evidence: body };
	}

	// A hard flag (e.g. a known drainer) is a confirmed-malicious signal even when
	// the boolean is absent; the endpoint carries it in hard_flags.
	if (result.malicious === true || (result.hard_flags?.length ?? 0) > 0) {
		return { verdict: TRUST_VERDICTS.MALICIOUS, reasons: [], evidence: body };
	}

	// Soft flags / a "review" rollup are unconfirmed suspicion → SUSPICIOUS (REVIEW).
	if (
		(result.soft_flags?.length ?? 0) > 0 ||
		parsed?.screening_verdict === "review"
	) {
		return { verdict: TRUST_VERDICTS.SUSPICIOUS, reasons: [], evidence: body };
	}

	// No negative flags. CLEAN, not "trusted": this imposes nothing and cannot
	// upgrade a decision. Any reputation score on the body is never read.
	return { verdict: TRUST_VERDICTS.CLEAN, reasons: [], evidence: body };
}

/** Cancellable deadline, mirroring the withTimeout pattern in verify/getConfirmedTx. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("trust provider timed out")),
			ms,
		);
	});

	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}) as Promise<T>;
}
