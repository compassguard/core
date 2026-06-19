/**
 * Functional tests for PostHog client singleton.
 *
 * Verifies:
 * - Singleton pattern (same instance on repeated calls)
 * - capture() delegates to PostHog SDK
 * - captureException() delegates to PostHog SDK
 * - getInstallationDistinctId() fallback behavior
 * - Environment variable wiring
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-node", () => {
	const capture = vi.fn();
	const captureException = vi.fn();
	const shutdownAsync = vi.fn().mockResolvedValue(undefined);
	return {
		PostHog: vi.fn().mockImplementation(() => ({
			capture,
			captureException,
			shutdownAsync,
		})),
	};
});

describe("PostHog client singleton", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns the same PostHog instance on repeated calls", async () => {
		vi.resetModules();
		process.env.POSTHOG_API_KEY = "phk_test_123";
		process.env.POSTHOG_HOST = "https://us.i.posthog.com";

		const { getPostHogClient } = await import("./posthogClient");
		const clientA = getPostHogClient();
		const clientB = getPostHogClient();

		expect(clientA).toBe(clientB);
	});

	it("constructs PostHog with API key and host from env", async () => {
		vi.resetModules();
		process.env.POSTHOG_API_KEY = "phk_test_abc";
		process.env.POSTHOG_HOST = "https://eu.i.posthog.com";

		const { getPostHogClient } = await import("./posthogClient");
		const { PostHog } = await import("posthog-node");

		getPostHogClient();

		expect(PostHog).toHaveBeenCalledWith("phk_test_abc", {
			host: "https://eu.i.posthog.com",
			enableExceptionAutocapture: true,
		});
	});

	it("uses empty string when POSTHOG_API_KEY is missing", async () => {
		vi.resetModules();
		delete process.env.POSTHOG_API_KEY;
		process.env.POSTHOG_HOST = "https://us.i.posthog.com";

		const { getPostHogClient } = await import("./posthogClient");
		const { PostHog } = await import("posthog-node");

		getPostHogClient();

		expect(PostHog).toHaveBeenCalledWith("", {
			host: "https://us.i.posthog.com",
			enableExceptionAutocapture: true,
		});
	});

	it("capture() delegates to the PostHog SDK", async () => {
		vi.resetModules();
		process.env.POSTHOG_API_KEY = "phk_test_123";

		const { getPostHogClient } = await import("./posthogClient");
		const client = getPostHogClient();

		client.capture({
			distinctId: "user-1",
			event: "test_event",
			properties: { foo: "bar" },
		});

		expect(client.capture).toHaveBeenCalledWith({
			distinctId: "user-1",
			event: "test_event",
			properties: { foo: "bar" },
		});
	});

	it("captureException() delegates to the PostHog SDK", async () => {
		vi.resetModules();
		process.env.POSTHOG_API_KEY = "phk_test_123";

		const { getPostHogClient } = await import("./posthogClient");
		const client = getPostHogClient();
		const error = new Error("test error");

		client.captureException(error, "user-1", { context: "test" });

		expect(client.captureException).toHaveBeenCalledWith(
			error,
			"user-1",
			{ context: "test" },
		);
	});
});

describe("getInstallationDistinctId", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns COMPASS_INSTALLATION_ID when set", async () => {
		vi.resetModules();
		process.env.COMPASS_INSTALLATION_ID = "inst_abc123";

		const { getInstallationDistinctId } = await import("./posthogClient");
		expect(getInstallationDistinctId()).toBe("inst_abc123");
	});

	it("returns 'compass-system' as fallback when env is unset", async () => {
		vi.resetModules();
		delete process.env.COMPASS_INSTALLATION_ID;

		const { getInstallationDistinctId } = await import("./posthogClient");
		expect(getInstallationDistinctId()).toBe("compass-system");
	});
});
