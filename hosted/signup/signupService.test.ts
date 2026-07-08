import { describe, expect, it } from "vitest";

import { createInMemoryCredentialStore } from "../credential/credentialStore";

import { createSignupService } from "./signupService";

describe("createSignupService", () => {
	it("issues a key whose hash resolves to the normalized email", async () => {
		const store = createInMemoryCredentialStore();
		const service = createSignupService({
			credentialStore: store,
			generateKey: () => "raw-key-123",
			hashKey: (raw) => `hash(${raw})`,
		});

		const response = await service.signup({ email: "Alice@Example.com" });

		// The raw key is returned once; the email is normalized in the response.
		expect(response.apiKey).toBe("raw-key-123");
		expect(response.email).toBe("alice@example.com");
		// The store received the HASH (not the raw key); it resolves to the normalized identity.
		expect(await store.resolveActive("hash(raw-key-123)")).toEqual({
			email: "alice@example.com",
		});
	});

	it("defaults to the real generator/hash so the raw key is never what the store holds", async () => {
		const store = createInMemoryCredentialStore();
		const service = createSignupService({ credentialStore: store });

		const response = await service.signup({ email: "b@example.com" });

		expect(response.apiKey).toMatch(/^compass_/);
		// Only the hash is persisted, so the raw key never resolves directly.
		expect(await store.resolveActive(response.apiKey)).toBeUndefined();
	});
});
