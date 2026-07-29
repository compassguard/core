import { describe, expect, it, vi } from "vitest";

import { MAGICBLOCK_OBSERVATION_SCHEMA } from "../../magicBlockDevnetObservationContracts";
import { createMagicBlockHostedAuditClient } from "./magicBlockHostedAuditClient";
import { extractMagicBlockObservationFromStructuredContent } from "./magicBlockMcpObservationExtractor";
import { createMagicBlockMcpObserver } from "./magicBlockMcpObserver";
import { readMagicBlockMcpObserverEnvConfig } from "./magicBlockMcpObserverConfig";
import {
	MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES,
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
				COMPASS_MAGICBLOCK_MCP_OBSERVER_TIMEOUT_MS: "1001",
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
			timeoutMs: 500,
		});
	});
});

describe("MagicBlock one-way hosted audit client", () => {
	it("sends one bounded authenticated POST and ignores its response body", async () => {
		const transport: MagicBlockMcpAuditTransport = vi.fn(async () => ({
			status: 202,
			get body() {
				throw new Error("response body must not be read");
			},
		}));
		const client = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: API_KEY,
			timeoutMs: 100,
			transport,
		});

		await expect(client.observe(validObservation())).resolves.toEqual({
			outcome: "delivered",
			status: 202,
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
			outcome: "timeout",
		});
		expect(Date.now() - startedAt).toBeLessThan(250);
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
			outcome: "transport_error",
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
			outcome: "transport_error",
		});
	});
});

describe("MagicBlock MCP observer", () => {
	it("forwards only the already detached observation contract", async () => {
		const auditClient = {
			observe: vi.fn(async () => ({ outcome: "delivered" as const, status: 204 })),
		};
		const observer = createMagicBlockMcpObserver({ auditClient });
		const observation = Object.freeze(validObservation());

		await expect(
			observer(observation),
		).resolves.toEqual({ outcome: "delivered", status: 204 });
		expect(auditClient.observe).toHaveBeenCalledWith(observation);
	});
});

function validObservation(): MagicBlockMcpObservation {
	return {
		schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
		observationId: "obs-mcp-1",
		unsignedTransactionBase64: "AQ==",
	};
}
