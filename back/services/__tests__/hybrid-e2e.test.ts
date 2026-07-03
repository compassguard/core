import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { createHostedApp } from "@hosted/app";
import { createInMemoryAuditStore } from "@hosted/audit/auditStore";
import type { AuditStore } from "@shared/auditContracts";
import type {
	EvaluateActionRequest,
	EvaluateActionResponse,
} from "@shared/evaluationContracts";

describe("hybrid MCP stdio e2e", () => {
	it("enforces local allow/deny paths and hosted allow/timeout paths", async () => {
		const auditStore = createInMemoryAuditStore();
		const hostedServer = await startHostedServer(auditStore);
		const fixturePath = join(
			process.cwd(),
			"back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts",
		);
		const mcpServerPath = join(process.cwd(), "back/services/mcp/server/mcpServer.ts");
		const serverSnippet =
			`import { startCompassMcpStdioServer } from ${JSON.stringify(mcpServerPath)};` +
			"startCompassMcpStdioServer().catch((error) => {" +
			"console.error(error instanceof Error ? error.stack ?? error.message : String(error));" +
			"process.exit(1);" +
			"});";
		const transport = new StdioClientTransport({
			command: "npx",
			args: [
				"tsx",
				"-e",
				serverSnippet,
				"--",
				"--downstream-name",
				"fixture",
				"--downstream-command",
				"npx",
				"--downstream-args-json",
				JSON.stringify(["tsx", fixturePath]),
			],
				env: {
					...process.env,
					COMPASS_HYBRID_GUARD_ENABLED: "true",
					COMPASS_HOSTED_API_URL: hostedServer.url,
					COMPASS_HOSTED_API_KEY: "hosted-secret",
					COMPASS_HOSTED_TIMEOUT_MS: "200",
				},
			stderr: "pipe",
		});
		const client = new Client({ name: "compass-hybrid-e2e", version: "0.0.0" });

		try {
			await client.connect(transport);

			const readOnlyResult = await client.callTool({
				name: "read_file",
				arguments: { path: "/tmp/example.txt" },
			});
			expect(readOnlyResult).toMatchObject({
				structuredContent: {
					ok: true,
					toolName: "read_file",
					arguments: { path: "/tmp/example.txt" },
				},
				isError: false,
			});

			const hostedAllowResult = await client.callTool({
				name: "transfer_sol",
				arguments: { recipient: "wallet", amountSol: 1, userId: "user_e2e" },
			});
			expect(hostedAllowResult).toMatchObject({
				structuredContent: {
					ok: true,
					toolName: "transfer_sol",
					arguments: {
						recipient: "wallet",
						amountSol: 1,
						userId: "user_e2e",
					},
				},
				isError: false,
			});

			const denyResult = await client.callTool({
				name: "sign_and_send_transaction",
				arguments: { transaction: "base64" },
			});
			expect(denyResult).toMatchObject({
				isError: true,
				structuredContent: {
					decision: "deny",
					toolName: "sign_and_send_transaction",
				},
			});

			const timeoutResult = await client.callTool({
				name: "transfer_timeout",
				arguments: { recipient: "wallet", amountSol: 1, userId: "user_e2e" },
			});
			expect(timeoutResult).toMatchObject({
				isError: true,
				structuredContent: {
					decision: "deny",
					reason: expect.stringContaining("HOSTED_TIMEOUT"),
				},
			});

			const auditsResponse = await fetch(`${hostedServer.url}/v1/audits?userId=user_e2e`, {
				headers: {
					Authorization: "Bearer hosted-secret",
				},
			});
			expect(auditsResponse.status).toBe(200);
			expect(await auditsResponse.json()).toEqual({
				audits: [
					{
						correlationId: expect.any(String),
						auditRef: expect.any(String),
						toolName: "transfer_sol",
						decision: "allow",
						riskLevel: "low",
						reasons: ["HOSTED_ALLOW"],
						occurredAt: expect.any(String),
					},
				],
			});
		} finally {
			await client.close();
			await hostedServer.close();
		}
	}, 30_000);
});

async function startHostedServer(auditStore: AuditStore): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	const app = createHostedApp({
		auth: { apiKey: "hosted-secret" },
		health: {
			dependencies: {
				auditStore: "ok",
				policy: "ok",
				llm: "ok",
			},
		},
		audit: auditStore,
		evaluations: {
			evaluateAction: async (
				request: EvaluateActionRequest,
			): Promise<EvaluateActionResponse> => {
				if (request.toolName === "transfer_timeout") {
					await sleep(500);
					return {
						correlationId: request.correlationId,
						decision: "allow",
						riskLevel: "low",
						reasons: ["HOSTED_ALLOW"],
						auditRef: "aud_timeout_unused",
					};
				}

				const auditWrite = await auditStore.writeAudit({
					idempotencyKey: request.idempotencyKey,
					userId: readUserId(request.arguments),
					sessionId: request.agentContext?.sessionId,
					entry: {
						correlationId: request.correlationId,
						auditRef: `aud_${request.correlationId}`,
						toolName: request.toolName,
						decision: "allow",
						riskLevel: "low",
						reasons: ["HOSTED_ALLOW"],
						occurredAt: request.requestedAt,
					},
				});

				return {
					correlationId: auditWrite.correlationId,
					decision: "allow",
					riskLevel: "low",
					reasons: ["HOSTED_ALLOW"],
					auditRef: auditWrite.auditRef,
				};
			},
		},
	});

	const server = createServer(async (request, response) => {
		await handleHonoRequest(app, request, response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

async function handleHonoRequest(
	app: ReturnType<typeof createHostedApp>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readRequestBody(request);
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
	const honoResponse = await app.fetch(
		new Request(url, {
			method: request.method,
			headers: request.headers as HeadersInit,
			body: shouldSendBody(request.method) ? body : undefined,
			duplex: "half",
		} as RequestInit),
	);

	response.statusCode = honoResponse.status;
	honoResponse.headers.forEach((value, key) => {
		response.setHeader(key, value);
	});
	response.end(Buffer.from(await honoResponse.arrayBuffer()));
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function shouldSendBody(method?: string): boolean {
	return method !== "GET" && method !== "HEAD";
}

function readUserId(
	argumentsValue: Record<string, unknown> | undefined,
): string | undefined {
	const candidate = argumentsValue?.userId;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
