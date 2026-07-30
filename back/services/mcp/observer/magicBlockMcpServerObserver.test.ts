import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { MAGICBLOCK_OBSERVATION_SCHEMA } from "../../magicBlockDevnetObservationContracts";
import { createProxyMcpServerHandlers } from "../server/mcpServer";
import { createMagicBlockHostedAuditClient } from "./magicBlockHostedAuditClient";
import { createMagicBlockMcpObserver } from "./magicBlockMcpObserver";
import type { MagicBlockMcpAuditTransport } from "./magicBlockMcpObserverContracts";

const REQUEST = { params: { name: "build_transaction", arguments: {} } };
const AUDIT_URL = "https://audit.example/api/magicblock-devnet/audit";

describe("MagicBlock observer at the real MCP callTool wrapper", () => {
	it("surfaces an explicit retryable audit state when no observer is injected", async () => {
		const downstream = validDownstreamResult();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned).not.toBe(downstream);
		expect(returned.structuredContent).toEqual({
			...validStructuredContent(),
			compassAudit: retryableAudit(),
		});
	});

	it("awaits a confirmed audit and attaches its proof to the Compass result", async () => {
		const downstream = validDownstreamResult();
		const transport: MagicBlockMcpAuditTransport = vi.fn(async () => ({
			status: 200,
			json: async () => confirmedIngressResponse(),
		}));
		const handlers = observedHandlers(downstream, transport);

		const returned = await handlers.callTool(REQUEST);

		expect(transport).toHaveBeenCalledTimes(1);
		expect(returned).not.toBe(downstream);
		expect(returned.structuredContent).toMatchObject({
			compassAudit: {
				outcome: "confirmed",
				status: 200,
				audit: confirmedIngressResponse(),
			},
		});
	});

	it("surfaces a retryable state on observer rejection", async () => {
		const downstream = validDownstreamResult();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: vi.fn(async () => {
				throw new Error("audit unavailable");
			}),
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned.structuredContent).toEqual({
			...validStructuredContent(),
			compassAudit: retryableAudit(),
		});
	});

	it("surfaces a retryable state on a synchronous sink throw", async () => {
		const downstream = validDownstreamResult();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: () => {
				throw new Error("synchronous audit failure");
			},
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned.structuredContent).toEqual({
			...validStructuredContent(),
			compassAudit: retryableAudit(),
		});
	});

	it("surfaces a retryable state on a rejecting custom PromiseLike", async () => {
		const downstream = validDownstreamResult();
		const rejectingThenable = {
			then(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			) {
				reject(new Error("custom thenable audit failure"));
			},
		} as unknown as PromiseLike<never>;
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: () => rejectingThenable,
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned.structuredContent).toEqual({
			...validStructuredContent(),
			compassAudit: retryableAudit(),
		});
	});

	it("passes a detached frozen observation so sink mutation cannot affect the source result", async () => {
		const downstream = validDownstreamResult();
		const structuredContent = downstream.structuredContent;
		const sink = vi.fn((observation) => {
			expect(observation).not.toBe(structuredContent);
			expect(Object.isFrozen(observation)).toBe(true);
			(
				observation as { observationId: string }
			).observationId = "mutated-by-sink";
			return retryableAudit();
		});
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: sink,
		});

		const returned = await handlers.callTool(REQUEST);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(downstream.structuredContent).toEqual(validStructuredContent());
		expect(returned.structuredContent).toEqual({
			...validStructuredContent(),
			compassAudit: retryableAudit(),
		});
	});

	it.each([
		["timeout", () => new Promise<{ status: number }>(() => undefined), 10],
		["non-2xx", async () => ({ status: 401 }), 100],
	] as const)(
		"surfaces a retryable state on audit %s",
		async (_name, transportImplementation, timeoutMs) => {
			const downstream = validDownstreamResult();
			const transport: MagicBlockMcpAuditTransport = vi.fn(
				transportImplementation,
			);
			const handlers = observedHandlers(downstream, transport, timeoutMs);

			const returned = await handlers.callTool(REQUEST);
			expect(returned.structuredContent).toMatchObject({
				compassAudit: { outcome: "retryable_failure", retryable: true },
			});
		},
	);

	it("swallows a transport rejection that arrives after the timeout", async () => {
		const downstream = validDownstreamResult();
		let rejectTransport: ((reason: Error) => void) | undefined;
		const transport: MagicBlockMcpAuditTransport = () =>
			new Promise((_resolve, reject) => {
				rejectTransport = reject;
			});
		const handlers = observedHandlers(downstream, transport, 10);

		const returned = await handlers.callTool(REQUEST);
		rejectTransport?.(new Error("late transport rejection"));
		await new Promise((resolve) => setImmediate(resolve));

		expect(returned.structuredContent).toMatchObject({
			compassAudit: { outcome: "retryable_failure", retryable: true },
		});
	});

	it.each([
		["irrelevant", { ok: true }],
		[
			"malformed",
			{
				schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
				observationId: "obs-entry",
				unsignedTransactionBase64: "not-base64",
			},
		],
		[
			"extra-key",
			{
				...validStructuredContent(),
				extra: "not allowed",
			},
		],
	])("does not audit %s structured content", async (_name, structuredContent) => {
		const downstream: CallToolResult = {
			content: [{ type: "text", text: JSON.stringify(validStructuredContent()) }],
			structuredContent,
			isError: false,
		};
		const transport: MagicBlockMcpAuditTransport = vi.fn(async () => ({
			status: 204,
		}));
		const handlers = observedHandlers(downstream, transport);

		const returned = await handlers.callTool(REQUEST);
		expect(transport).not.toHaveBeenCalled();
		expect(returned).toBe(downstream);
	});

	it("does not observe an allowed downstream error result", async () => {
		const downstream: CallToolResult = {
			...validDownstreamResult(),
			isError: true,
		};
		const observer = vi.fn();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: observer,
		});

		expect(await handlers.callTool(REQUEST)).toBe(downstream);
		expect(observer).not.toHaveBeenCalled();
	});

	it.each(["deny", "require_approval"] as const)(
		"does not observe a %s outcome",
		async (outcome) => {
			const observer = vi.fn();
			const handlers = createProxyMcpServerHandlers({
				proxyCallTool: vi.fn(async () => ({
					outcome,
					reason: "not allowed",
				})),
				observeMagicBlockObservation: observer,
			});

			const returned = await handlers.callTool(REQUEST);
			expect(returned.isError).toBe(true);
			expect(observer).not.toHaveBeenCalled();
		},
	);
});

function observedHandlers(
	downstream: CallToolResult,
	transport: MagicBlockMcpAuditTransport,
	timeoutMs = 100,
) {
	const auditClient = createMagicBlockHostedAuditClient({
		url: AUDIT_URL,
		apiKey: "observer-secret",
		timeoutMs,
		transport,
	});
	return createProxyMcpServerHandlers({
		proxyCallTool: allowed(downstream),
		observeMagicBlockObservation: createMagicBlockMcpObserver({ auditClient }),
	});
}

function allowed(data: CallToolResult) {
	return vi.fn(async () => ({
		outcome: "allow" as const,
		reason: "allowed",
		data,
	}));
}

function validDownstreamResult(): CallToolResult {
	return {
		content: [{ type: "text", text: "unsigned transaction built" }],
		structuredContent: validStructuredContent(),
		isError: false,
	};
}

function validStructuredContent() {
	return {
		schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
		observationId: "obs-entry",
		unsignedTransactionBase64: "AQ==",
	};
}

function retryableAudit() {
	return {
		outcome: "retryable_failure" as const,
		retryable: true as const,
		code: "AUDIT_UNAVAILABLE" as const,
	};
}

function confirmedIngressResponse() {
	return {
		schemaVersion: "compass.magicblock-devnet-observation-result/v1",
		observationId: "obs-entry",
		outcome: "review_required",
		audit: {
			auditEventId: "audit-entry-1",
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
					a: "audit-entry-1",
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
