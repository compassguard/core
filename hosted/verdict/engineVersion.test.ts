import { describe, expect, it } from "vitest";

import { readEngineVersion } from "./engineVersion";

const env = (values: Record<string, string | undefined>) => (key: string) => values[key];

describe("readEngineVersion", () => {
	it("prefers VERCEL_GIT_COMMIT_SHA (set automatically on Vercel deployments)", () => {
		expect(
			readEngineVersion(env({ VERCEL_GIT_COMMIT_SHA: "abc123", COMPASS_ENGINE_VERSION: "zzz" })),
		).toBe("abc123");
	});

	it("falls back to COMPASS_ENGINE_VERSION off Vercel", () => {
		expect(readEngineVersion(env({ COMPASS_ENGINE_VERSION: "bun-build-7" }))).toBe("bun-build-7");
	});

	it("returns undefined when neither is set — absent, never an 'unknown' sentinel", () => {
		// A sentinel that looks like a value invites being compared, grouped and trusted;
		// an absent field reads as absent. Local dev and tests stamp nothing, honestly.
		expect(readEngineVersion(env({}))).toBeUndefined();
	});

	it("treats blank/whitespace values as unset", () => {
		expect(readEngineVersion(env({ VERCEL_GIT_COMMIT_SHA: "   " }))).toBeUndefined();
		expect(
			readEngineVersion(env({ VERCEL_GIT_COMMIT_SHA: "  ", COMPASS_ENGINE_VERSION: "fallback" })),
		).toBe("fallback");
	});

	it("trims surrounding whitespace", () => {
		expect(readEngineVersion(env({ COMPASS_ENGINE_VERSION: " sha1 \n" }))).toBe("sha1");
	});
});
