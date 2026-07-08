export type CredentialIdentity = { email: string };

export type CredentialRecord = {
	email: string;
	tokenHash: string;
	createdAt: string;
	revokedAt?: string;
};

export type IssueCredentialInput = {
	email: string;
	tokenHash: string;
	createdAt: string;
};

export type CredentialStore = {
	issue(input: IssueCredentialInput): Promise<void>;
	resolveActive(tokenHash: string): Promise<CredentialIdentity | undefined>;
	revokeByEmail(email: string): Promise<number>;
};

export type CredentialStoreOptions = {
	/** ISO timestamp source for revokedAt. Defaults to new Date().toISOString(). */
	isoNow?: () => string;
};

/** Normalize an email to its canonical identity form so casing/whitespace never splits one caller. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * In-memory credential store keyed by tokenHash (single-process / demo / tests).
 * The durable backing (Postgres) is a drop-in swap — see createPgCredentialStore.
 *
 * A credential is either active (revokedAt undefined) or revoked; resolveActive returns
 * an identity only for an active credential, and revokeByEmail is the sole transition.
 * The raw key is never stored — only its hash keys the map.
 */
export function createInMemoryCredentialStore(
	options: CredentialStoreOptions = {},
): CredentialStore {
	const isoNow = options.isoNow ?? (() => new Date().toISOString());
	const records = new Map<string, CredentialRecord>();

	return {
		async issue(input: IssueCredentialInput): Promise<void> {
			// Existence guard: the first issue for a tokenHash wins; a replayed issue is inert
			// and never overwrites an already-stored (possibly revoked) credential.
			if (records.has(input.tokenHash)) return;
			records.set(input.tokenHash, {
				email: normalizeEmail(input.email),
				tokenHash: input.tokenHash,
				createdAt: input.createdAt,
			});
		},

		async resolveActive(tokenHash: string): Promise<CredentialIdentity | undefined> {
			const record = records.get(tokenHash);
			if (!record || record.revokedAt !== undefined) return undefined;
			return { email: record.email };
		},

		async revokeByEmail(email: string): Promise<number> {
			const target = normalizeEmail(email);
			const revokedAt = isoNow();
			let disabled = 0;
			for (const record of records.values()) {
				if (record.email === target && record.revokedAt === undefined) {
					record.revokedAt = revokedAt;
					disabled += 1;
				}
			}
			return disabled;
		},
	};
}
