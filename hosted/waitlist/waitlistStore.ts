import { normalizeEmail } from "../credential/credentialStore";

export type WaitlistEntry = { email: string; createdAt: string };

export type AddWaitlistInput = { email: string; createdAt: string };

export type WaitlistStore = {
	/** First-write-wins: a repeat join for the same (normalized) email is inert. */
	add(input: AddWaitlistInput): Promise<void>;
	/** Every address ever joined, in no particular order. */
	list(): Promise<WaitlistEntry[]>;
};

/**
 * In-memory waitlist store keyed by normalized email (single-process / demo / tests).
 * The durable backing (Postgres) is a drop-in swap — see createPgWaitlistStore.
 *
 * Unlike CredentialStore, there is no token to mint and nothing to revoke: joining the
 * waitlist records intent only, it grants no access.
 */
export function createInMemoryWaitlistStore(): WaitlistStore {
	const records = new Map<string, WaitlistEntry>();

	return {
		async add(input: AddWaitlistInput): Promise<void> {
			const email = normalizeEmail(input.email);
			// Existence guard: the first join for an email wins: a replayed join is inert
			// and never overwrites the original createdAt.
			if (records.has(email)) return;
			records.set(email, { email, createdAt: input.createdAt });
		},

		async list(): Promise<WaitlistEntry[]> {
			return [...records.values()];
		},
	};
}
