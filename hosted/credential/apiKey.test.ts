import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateApiKey, hashApiKey } from "./apiKey";

describe("generateApiKey", () => {
	it("returns a compass_-prefixed token", () => {
		expect(generateApiKey().startsWith("compass_")).toBe(true);
	});

	it("returns a distinct value on each call (uniqueness)", () => {
		expect(generateApiKey()).not.toBe(generateApiKey());
	});

	it("uses a non-trivial URL-safe base64 suffix after the prefix", () => {
		const suffix = generateApiKey().slice("compass_".length);
		expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
		// 32 random bytes → a 43-char base64url string; assert non-trivially long.
		expect(suffix.length).toBeGreaterThanOrEqual(40);
	});
});

describe("hashApiKey", () => {
	it("is deterministic (same input → same output)", () => {
		expect(hashApiKey("compass_test")).toBe(hashApiKey("compass_test"));
	});

	it("returns 64 lowercase hex chars", () => {
		expect(hashApiKey("compass_test")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("equals the SHA-256 hex of the exact input (known vector)", () => {
		// Independent oracle: SHA-256 of the exact string via node:crypto.
		const expected = createHash("sha256")
			.update("compass_test")
			.digest("hex");
		expect(hashApiKey("compass_test")).toBe(expected);
		// Pinned digest — a genuine external known-answer vector.
		expect(hashApiKey("compass_test")).toBe(
			"4328a9b0938fd5db6a24cfbe9e471868fba722e2f3ff113ec169c6044b220b92",
		);
	});

	it("produces different hashes for different inputs", () => {
		expect(hashApiKey("compass_a")).not.toBe(hashApiKey("compass_b"));
	});
});
