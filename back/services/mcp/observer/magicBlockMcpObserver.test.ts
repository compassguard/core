import { describe, expect, it, vi } from "vitest";

import { MAGICBLOCK_OBSERVATION_SCHEMA } from "../../magicBlockDevnetObservationContracts";
import { createMagicBlockHostedAuditClient } from "./magicBlockHostedAuditClient";
import { extractMagicBlockObservationFromStructuredContent } from "./magicBlockMcpObservationExtractor";
import { createMagicBlockMcpObserver } from "./magicBlockMcpObserver";
import { readMagicBlockMcpObserverEnvConfig } from "./magicBlockMcpObserverConfig";
import {
	MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES,
	MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES,
	type MagicBlockMcpAuditTransport,
	type MagicBlockMcpObservation,
} from "./magicBlockMcpObserverContracts";

const AUDIT_URL = "https://audit.example/api/magicblock-devnet/audit";
const API_KEY = "observer-secret";

describe("MagicBlock MCP closed observation extractor", () => {
	it("accepts only the exact allowlisted structured-content root", () => {
		const observation = validObservation();
		const extracted =
			extractMagicBlockObservationFromStructuredContent(observation);
		expect(extracted).toEqual(observation);
		expect(extracted).not.toBe(observation);
		expect(Object.isFrozen(extracted)).toBe(true);
	});

	it.each(["AQ==", "AAE="])(
		"accepts canonical padded base64 %s",
		(unsignedTransactionBase64) => {
			expect(
				extractMagicBlockObservationFromStructuredContent({
					...validObservation(),
					unsignedTransactionBase64,
				}),
			).toMatchObject({ unsignedTransactionBase64 });
		},
	);

	it.each([
		["missing field", { schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA }],
		["extra field", { ...validObservation(), extra: true }],
		["invalid ID", { ...validObservation(), observationId: "../escape" }],
		["invalid base64", { ...validObservation(), unsignedTransactionBase64: "===" }],
		[
			"noncanonical double-padding bits",
			{ ...validObservation(), unsignedTransactionBase64: "AB==" },
		],
		[
			"noncanonical single-padding bits",
			{ ...validObservation(), unsignedTransactionBase64: "AAB=" },
		],
		[
			"oversized transaction",
			{
				...validObservation(),
				unsignedTransactionBase64: "A".repeat(1_648),
			},
		],
		[
			"nested envelope",
			{ observation: validObservation() },
		],
	])("skips %s", (_name, value) => {
		expect(
			extractMagicBlockObservationFromStructuredContent(value),
		).toBeUndefined();
	});

	it("does not inspect MCP text content", () => {
		const textOnly = {
			content: [{ type: "text", text: JSON.stringify(validObservation()) }],
		};
		expect(
			extractMagicBlockObservationFromStructuredContent(textOnly),
		).toBeUndefined();
	});
});

describe("MagicBlock MCP observer configuration", () => {
	it("is disabled by default and never reuses ingress credentials", () => {
		expect(
			readMagicBlockMcpObserverEnvConfig({
				COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED: "true",
				COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY: "ingress-secret",
				COMPASS_HOSTED_API_URL: "https://hosted.example",
			}),
		).toEqual({ enabled: false });
	});

	it.each([
		["missing URL", { COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY: API_KEY }],
		["missing key", { COMPASS_MAGICBLOCK_MCP_AUDIT_URL: AUDIT_URL }],
		[
			"invalid timeout",
			{
				COMPASS_MAGICBLOCK_MCP_AUDIT_URL: AUDIT_URL,
				COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY: API_KEY,
				COMPASS_MAGICBLOCK_MCP_OBSERVER_TIMEOUT_MS: "45001",
			},
		],
		[
			"unsafe URL",
			{
				COMPASS_MAGICBLOCK_MCP_AUDIT_URL:
					"http://127.0.0.1/api/magicblock-devnet/audit",
				COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY: API_KEY,
			},
		],
		[
			"unsafe key",
			{
				COMPASS_MAGICBLOCK_MCP_AUDIT_URL: AUDIT_URL,
				COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY: "bad key",
			},
		],
	])("does not activate with %s", (_name, partial) => {
		expect(
			readMagicBlockMcpObserverEnvConfig({
				COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED: "true",
				...partial,
			}),
		).toEqual({ enabled: false });
	});

	it("activates only the complete dedicated configuration", () => {
		expect(
			readMagicBlockMcpObserverEnvConfig({
				COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED: "true",
				COMPASS_MAGICBLOCK_MCP_AUDIT_URL: AUDIT_URL,
				COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY: API_KEY,
			}),
		).toEqual({
			enabled: true,
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 20_000,
		});
	});
});

describe("MagicBlock one-way hosted audit client", () => {
	it("sends one bounded authenticated POST and accepts only a confirmed audit", async () => {
		const transport: MagicBlockMcpAuditTransport = vi.fn(async () => ({
			status: 200,
			json: async () => confirmedAuditResponse(),
		}));
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport,
		});

		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "confirmed",
			status: 200,
			audit: confirmedAuditResponse(),
		});
		expect(transport).toHaveBeenCalledTimes(1);
		const [url, init] = vi.mocked(transport).mock.calls[0]!;
		expect(url).toBe(AUDIT_URL);
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(validObservation()),
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("enforces its timeout even when an injected transport ignores abort", async () => {
		const transport: MagicBlockMcpAuditTransport = vi.fn(
			() => new Promise(() => undefined),
		);
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 10,
			transport,
		});

		const startedAt = Date.now();
		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_TIMEOUT",
		});
		expect(Date.now() - startedAt).toBeLessThan(250);
	});

	it("keeps the deadline active while the response body is pending", async () => {
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 10,
			transport: async () => ({
				status: 200,
				json: () => new Promise(() => undefined),
			}),
		});
		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_TIMEOUT",
		});
	});

	it("rejects an oversized hosted response", async () => {
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport: async () => ({
				status: 200,
				json: async () => ({
					padding: "x".repeat(MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES),
				}),
			}),
		});
		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_UNAVAILABLE",
			status: 200,
		});
	});

	it("rejects an oversized payload before transport", async () => {
		const transport: MagicBlockMcpAuditTransport = vi.fn<
			Parameters<MagicBlockMcpAuditTransport>,
			ReturnType<MagicBlockMcpAuditTransport>
		>();
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport,
		});
		const oversized = {
			...validObservation(),
			unsignedTransactionBase64: "A".repeat(
				MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES,
			),
		};

		await expect(client.observe(oversized)).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_UNAVAILABLE",
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		"http://audit.example/api/magicblock-devnet/audit",
		"https://audit.example:444/api/magicblock-devnet/audit",
		"https://audit.example/api/magicblock-devnet/audit?next=true",
		"https://user@audit.example/api/magicblock-devnet/audit",
	])("rejects unsafe endpoint configuration %s", (url) => {
		expect(() =>
			createMagicBlockHostedAuditClient({
				url,
				apiKey: API_KEY,
				timeoutMs: 100,
			}),
		).toThrow("MagicBlock MCP audit client unavailable");
	});

	it("returns only a diagnostic for transport failure", async () => {
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport: () => {
				throw new Error("private hosted detail");
			},
		});
		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_UNAVAILABLE",
		});
	});

	it("does not treat an empty 2xx response as an audit success", async () => {
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport: async () => ({ status: 204 }),
		});
		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_UNAVAILABLE",
			status: 204,
		});
	});
});

describe("MagicBlock MCP observer", () => {
	it("forwards only the already detached observation contract", async () => {
		const auditClient = {
			observe: vi.fn(async () => ({
				outcome: "retryable_failure" as const,
				retryable: true as const,
				code: "AUDIT_UNAVAILABLE" as const,
			})),
		};
		const observer = createMagicBlockMcpObserver({ auditClient });
		const observation = Object.freeze(validObservation());

		await expect(
			observer(observation),
		).resolves.toEqual({
			outcome: "retryable_failure",
			retryable: true,
			code: "AUDIT_UNAVAILABLE",
		});
		expect(auditClient.observe).toHaveBeenCalledWith(observation);
	});
});

function confirmedAuditResponse() {
	return {
		schemaVersion: "compass.magicblock-devnet-observation-result/v1",
		observationId: "obs-mcp-1",
		outcome: "review_required",
		audit: {
			auditEventId: "audit-mcp-1",
			attestationDigest: "a".repeat(64),
			resultDigest: "b".repeat(64),
			previousLedgerDigest: "c".repeat(64),
			ledgerDigest: "d".repeat(64),
			registration: {
				status: "confirmed",
				cluster: "devnet",
				routerUrl: "https://devnet-router.magicblock.app/",
				signature: "2".repeat(64),
				signer: "11111111111111111111111111111111",
				slot: 123,
				commitmentDigest: "e".repeat(64),
				memo: `compass:audit:v1:${JSON.stringify({
					a: "audit-mcp-1",
					c: "e".repeat(64),
					l: "d".repeat(64),
					o: "review",
					p: "c".repeat(64),
					v: 1,
				})}`,
				verifiedAt: "2026-07-29T00:00:00.000Z",
			},
		},
	};
}

function validObservation(): MagicBlockMcpObservation {
	return {
		schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
		observationId: "obs-mcp-1",
		unsignedTransactionBase64: "AQ==",
	};
}
