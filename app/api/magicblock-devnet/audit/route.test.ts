import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("POST /api/magicblock-devnet/audit", () => {
	it("is absent by default and does not require database or network configuration", async () => {
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED", "false");
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY", "");
		vi.stubEnv("COMPASS_VERDICT_DB_URL", "");
		const { POST } = await import("./route");

		const response = await POST(
			new Request("https://api.compassguard.xyz/api/magicblock-devnet/audit", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: "NOT_FOUND", message: "Not found." },
		});
	});

	it("declares headroom above the eight-second runtime budget and twelve-second stale lease", async () => {
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED", "false");
		const { maxDuration } = await import("./route");

		expect(maxDuration).toBe(15);
	});

	it("fails closed when enabled without the dedicated key and shared database", async () => {
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED", "true");
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY", "");
		vi.stubEnv("COMPASS_VERDICT_DB_URL", "");
		const { POST } = await import("./route");

		const response = await POST(
			new Request("https://api.compassguard.xyz/api/magicblock-devnet/audit", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(503);
	});
});
