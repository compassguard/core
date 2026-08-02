import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("POST /api/magicblock-devnet/audit/import", () => {
	it("is absent by default", async () => {
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED", "false");
		const { POST } = await import("./route");
		const response = await POST(new Request("https://api.test/api/magicblock-devnet/audit/import", { method: "POST" }));
		expect(response.status).toBe(404);
	});

	it("fails closed when enabled without auth, DB, or required public signer", async () => {
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED", "true");
		vi.stubEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY", "");
		vi.stubEnv("COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY", "");
		vi.stubEnv("COMPASS_VERDICT_DB_URL", "");
		const { POST } = await import("./route");
		const response = await POST(new Request("https://api.test/api/magicblock-devnet/audit/import", { method: "POST" }));
		expect(response.status).toBe(503);
	});

	it("composition has no submit, register, transaction-send, or signer-secret capability", async () => {
		const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../../../../hosted/magicblock/magicBlockAuditProofImportIngressFromEnv.ts", import.meta.url), "utf8"));
		expect(source).not.toMatch(/Submitter|\.register\(|sendTransaction|SIGNER_SECRET/);
	});
});
