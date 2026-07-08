import { generateApiKey, hashApiKey } from "../credential/apiKey";
import {
	normalizeEmail,
	type CredentialStore,
} from "../credential/credentialStore";

import type {
	SignupRequest,
	SignupResponse,
	SignupService,
} from "./signupContracts";

export type SignupServiceDependencies = {
	credentialStore: CredentialStore;
	isoNow?: () => string;
	/** Injectable so tests are deterministic; defaults to the real opaque-key generator. */
	generateKey?: () => string;
	/** Injectable so tests are deterministic; defaults to the real SHA-256 hash. */
	hashKey?: (raw: string) => string;
};

export function createSignupService(
	deps: SignupServiceDependencies,
): SignupService {
	const { credentialStore } = deps;
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());
	const generateKey = deps.generateKey ?? generateApiKey;
	const hashKey = deps.hashKey ?? hashApiKey;

	return {
		async signup(request: SignupRequest): Promise<SignupResponse> {
			const email = normalizeEmail(request.email);
			// Mint once; persist ONLY the hash. The raw key is returned to the caller here and is
			// never stored or logged (D2/D14/R7) — the store and every log line see the hash only.
			const rawKey = generateKey();
			const tokenHash = hashKey(rawKey);
			await credentialStore.issue({ email, tokenHash, createdAt: isoNow() });
			return { email, apiKey: rawKey };
		},
	};
}
