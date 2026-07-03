import { describe, expect, it } from "vitest";

import { readHostedBackendEnvConfig } from "../envConfig";

describe("envConfig", () => {
	it("reads hosted backend defaults", () => {
		expect(readHostedBackendEnvConfig({})).toEqual({
			apiKey: undefined,
			apiUrl: undefined,
			hybridGuardEnabled: true,
			timeoutMs: 750,
		});
	});

	it("parses hosted backend env overrides", () => {
		expect(
			readHostedBackendEnvConfig({
				COMPASS_HOSTED_API_URL: "https://hosted.example.com",
				COMPASS_HOSTED_API_KEY: "secret",
				COMPASS_HOSTED_TIMEOUT_MS: "1200",
				COMPASS_HYBRID_GUARD_ENABLED: "false",
			}),
		).toEqual({
			apiKey: "secret",
			apiUrl: "https://hosted.example.com",
			hybridGuardEnabled: false,
			timeoutMs: 1200,
		});
	});
});
