import type { Mandate, MandateStore } from "@shared/mandateContracts";

/**
 * In-memory mandate store keyed by ownerId (single-process / tests). The durable backing
 * (createPgMandateStore) is a drop-in swap; both satisfy describeMandateStoreContract.
 */
export function createInMemoryMandateStore(): MandateStore {
	const mandates = new Map<string, Mandate>();

	return {
		async put(mandate: Mandate): Promise<void> {
			mandates.set(mandate.ownerId, { ...mandate });
		},

		async get(ownerId: string): Promise<Mandate | undefined> {
			const stored = mandates.get(ownerId);
			return stored ? { ...stored } : undefined;
		},
	};
}
