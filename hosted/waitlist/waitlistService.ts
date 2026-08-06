import { normalizeEmail } from "../credential/credentialStore";

import type {
	WaitlistRequest,
	WaitlistResponse,
	WaitlistService,
} from "./waitlistContracts";
import type { WaitlistStore } from "./waitlistStore";

export type WaitlistServiceDependencies = {
	waitlistStore: WaitlistStore;
	isoNow?: () => string;
};

/**
 * Unlike signup, this mints nothing: joining the waitlist records an email and grants no
 * credential. The response echoes the normalized email back so the caller can confirm what
 * was recorded, same shape discipline as signup's response.
 */
export function createWaitlistService(
	deps: WaitlistServiceDependencies,
): WaitlistService {
	const { waitlistStore } = deps;
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());

	return {
		async join(request: WaitlistRequest): Promise<WaitlistResponse> {
			const email = normalizeEmail(request.email);
			await waitlistStore.add({ email, createdAt: isoNow() });
			return { email };
		},
	};
}
