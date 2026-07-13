import {
	TRUST_VERDICTS,
	type TrustProvider,
	type TrustSignal,
} from "@shared/trustContracts";

const NO_SIGNAL: TrustSignal = { verdict: TRUST_VERDICTS.NO_SIGNAL, reasons: [] };

export type NsgoodsProviderOptions = {
	baseUrl?: string;
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

/** The provisional screening response shape. Every field is optional on purpose. */
type ScreenResponseBody = {
	result?: {
		sanctioned?: boolean;
		malicious?: boolean;
		inputs?: {
			revoked_count?: number;
			distinct_clients?: number;
			min_distinct_clients_required?: number;
		};
	};
};

/**
 * Adapter for the nsgoods counterparty-screening endpoint.
 *
 * Hardened against the two defects in the vendor's reference helper:
 *
 *   1. TRUE fail-open. The fetch, the status check and the JSON parse all sit
 *      inside the try, so a DNS failure, a timeout, or a 502 HTML error page
 *      yields NO_SIGNAL rather than throwing into the policy engine. (The
 *      reference helper only caught signature-recovery failures, so the failure
 *      mode that actually happens in production — the upstream being down — took
 *      the whole decision down with it.)
 *
 *   2. A hard deadline. This is a third party sitting in a decision path that is
 *      otherwise pure in-process compute, and the reference helper had no
 *      timeout at all. It is never allowed to hang.
 *
 * Failing open is safe here *only because* the signal is negative-evidence-only:
 * losing it can never relax a decision (see applyTrustSignal), so an outage costs
 * a missed extra caution, never a wrongly-permitted payment.
 *
 * The request/response shape is provisional — it tracks the screening endpoint
 * nsgoods described but has not yet shipped. Only this file should need to change
 * when it lands; the port and the invariant above it are stable.
 */
export function createNsgoodsTrustProvider(
	options: NsgoodsProviderOptions = {},
): TrustProvider {
	const baseUrl = options.baseUrl ?? "https://trust.nsgoods.org";
	const timeoutMs = options.timeoutMs ?? 800;
	const doFetch = options.fetchImpl ?? fetch;

	return {
		async screen(counterpartyAddress: string): Promise<TrustSignal> {
			if (counterpartyAddress.trim().length === 0) {
				return NO_SIGNAL;
			}

			try {
				const url = `${baseUrl}/screen?address=${encodeURIComponent(
					counterpartyAddress,
				)}`;
				const response = await withTimeout(doFetch(url), timeoutMs);
				if (!response.ok) {
					return NO_SIGNAL;
				}

				const body: unknown = JSON.parse(await response.text());

				if (options.verifySignature) {
					const verified = await options.verifySignature(body);
					if (!verified) {
						return NO_SIGNAL;
					}
				}

				return toTrustSignal(body);
			} catch {
				// Every failure is a missing signal: never an exception, never a
				// relaxation. Deliberately catch-all — a screening provider has no
				// business deciding how a policy engine handles its outages.
				return NO_SIGNAL;
			}
		},
	};
}

/** Map a screening response to a verdict. Strongest negative wins. */
function toTrustSignal(body: unknown): TrustSignal {
	const result = (body as ScreenResponseBody | null)?.result;
	if (!result) {
		return NO_SIGNAL;
	}

	if (result.sanctioned === true) {
		return { verdict: TRUST_VERDICTS.SANCTIONED, reasons: [], evidence: body };
	}

	if (result.malicious === true) {
		return { verdict: TRUST_VERDICTS.MALICIOUS, reasons: [], evidence: body };
	}

	const inputs = result.inputs ?? {};

	if ((inputs.revoked_count ?? 0) > 0) {
		return { verdict: TRUST_VERDICTS.REVOKED, reasons: [], evidence: body };
	}

	const distinctClients = inputs.distinct_clients;
	const minRequired = inputs.min_distinct_clients_required;
	if (
		typeof distinctClients === "number" &&
		typeof minRequired === "number" &&
		distinctClients < minRequired
	) {
		return {
			verdict: TRUST_VERDICTS.INSUFFICIENT_EVIDENCE,
			reasons: [],
			evidence: body,
		};
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
