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
	it("keeps the feature off when no observer is injected", async () => {
		const downstream = validDownstreamResult();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned).toBe(downstream);
	});

	it("awaits a successful audit observation and returns the exact downstream object", async () => {
		const downstream = validDownstreamResult();
		const transport: MagicBlockMcpAuditTransport = vi.fn(async () => ({
			status: 204,
		}));
		const handlers = observedHandlers(downstream, transport);

		const returned = await handlers.callTool(REQUEST);

		expect(transport).toHaveBeenCalledTimes(1);
		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(downstream);
	});

	it("fails open on observer rejection and preserves exact equality and identity", async () => {
		const downstream = validDownstreamResult();
		const snapshot = structuredClone(downstream);
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: vi.fn(async () => {
				throw new Error("audit unavailable");
			}),
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(snapshot);
	});

	it("fails open on a synchronous sink throw without changing the downstream result", async () => {
		const downstream = validDownstreamResult();
		const snapshot = structuredClone(downstream);
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: () => {
				throw new Error("synchronous audit failure");
			},
		});

		const returned = await handlers.callTool(REQUEST);
		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(snapshot);
	});

	it("fails open on a rejecting custom PromiseLike without changing the downstream result", async () => {
		const downstream = validDownstreamResult();
		const snapshot = structuredClone(downstream);
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
		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(snapshot);
	});

	it("passes a detached frozen observation so sink mutation cannot affect the result", async () => {
		const downstream = validDownstreamResult();
		const snapshot = structuredClone(downstream);
		const structuredContent = downstream.structuredContent;
		const sink = vi.fn((observation) => {
			expect(observation).not.toBe(structuredContent);
			expect(Object.isFrozen(observation)).toBe(true);
			(
				observation as { observationId: string }
			).observationId = "mutated-by-sink";
			return { outcome: "delivered" as const, status: 204 };
		});
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: allowed(downstream),
			observeMagicBlockObservation: sink,
		});

		const returned = await handlers.callTool(REQUEST);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(snapshot);
	});

	it.each([
		["timeout", () => new Promise<{ status: number }>(() => undefined), 10],
		["non-2xx", async () => ({ status: 401 }), 100],
	] as const)(
		"keeps identity and state unchanged on audit %s",
		async (_name, transportImplementation, timeoutMs) => {
			const downstream = validDownstreamResult();
			const snapshot = structuredClone(downstream);
			const transport: MagicBlockMcpAuditTransport = vi.fn(
				transportImplementation,
			);
			const handlers = observedHandlers(downstream, transport, timeoutMs);

			const returned = await handlers.callTool(REQUEST);
			expect(returned).toBe(downstream);
			expect(returned).toStrictEqual(snapshot);
		},
	);

	it("swallows a transport rejection that arrives after the timeout", async () => {
		const downstream = validDownstreamResult();
		const snapshot = structuredClone(downstream);
		let rejectTransport: ((reason: Error) => void) | undefined;
		const transport: MagicBlockMcpAuditTransport = () =>
			new Promise((_resolve, reject) => {
				rejectTransport = reject;
			});
		const handlers = observedHandlers(downstream, transport, 10);

		const returned = await handlers.callTool(REQUEST);
		rejectTransport?.(new Error("late transport rejection"));
		await new Promise((resolve) => setImmediate(resolve));

		expect(returned).toBe(downstream);
		expect(returned).toStrictEqual(snapshot);
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
