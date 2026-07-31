import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import {
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import {
	MAGICBLOCK_OBSERVATION_SCHEMA,
} from "../../magicBlockDevnetObservationContracts";
import type { MagicBlockPost } from "../../magicBlockDevnetPreflightTypes";
import { materializeMagicBlockAuditCommitment } from "../../magicBlockOnchainAudit";
import type {
	MagicBlockAuditCommitmentDetails,
	MagicBlockPreparedAuditTransaction,
} from "../../magicBlockOnchainAuditContracts";
import { createMagicBlockAuditIngress } from "../../../../hosted/magicblock/magicBlockAuditIngress";
import { createPgMagicBlockAppendOnlyAuditLedger } from "../../../../hosted/magicblock/magicBlockAuditLedgerPg";
import { createPgMagicBlockObservationStore } from "../../../../hosted/magicblock/magicBlockObservationStorePg";
import { createPgMagicBlockAuditRecordStore } from "../../../../hosted/magicblock/magicBlockAuditRecordStorePg";
import type { SqlExecutor } from "../../../../hosted/verdict/verdictStorePg";
import type { DownstreamMcpClient } from "../proxy/mcpProxyContracts";
import { createProxyMcpServer } from "../server/mcpServer";
import { createMagicBlockHostedAuditClient } from "./magicBlockHostedAuditClient";
import { createMagicBlockMcpObserver } from "./magicBlockMcpObserver";
import type { MagicBlockMcpAuditTransport } from "./magicBlockMcpObserverContracts";

const NOW = "2026-07-28T12:00:00.000Z";
const AUDIT_URL = "https://audit.example/api/magicblock-devnet/audit";

function preparedAuditTransaction(
	details: MagicBlockAuditCommitmentDetails,
): MagicBlockPreparedAuditTransaction {
	const signer = Keypair.generate();
	const commitment = materializeMagicBlockAuditCommitment(details);
	const recentBlockhash = Keypair.generate().publicKey.toBase58();
	const transaction = new Transaction({
		feePayer: signer.publicKey,
		recentBlockhash,
	}).add(
		new TransactionInstruction({
			programId: new PublicKey(
				"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
			),
			keys: [
				{ pubkey: signer.publicKey, isSigner: true, isWritable: false },
			],
			data: Buffer.from(commitment.memo, "utf8"),
		}),
	);
	transaction.sign(signer);
	const serialized = transaction.serialize();
	return {
		schemaVersion: "compass.magicblock-prepared-audit-transaction/v1",
		cluster: "devnet",
		lane: "magicblock_devnet_audit_memo",
		valueTransferLamports: 0,
		signer: signer.publicKey.toBase58(),
		signature: bs58.encode(transaction.signature as Buffer),
		commitmentDigest: commitment.commitmentDigest,
		memo: commitment.memo,
		recentBlockhash,
		lastValidBlockHeight: 100,
		serializedTransactionBase64: serialized.toString("base64"),
		serializedTransactionDigest: createHash("sha256")
			.update(serialized)
			.digest("hex"),
		blockhashValidityEvidence: {
			solana: { endpoint: "solana_devnet", recentBlockhash, commitment: "confirmed", contextSlot: 10, validity: "valid", observedAt: NOW },
			magicRouter: { endpoint: "magic_router", recentBlockhash, commitment: "confirmed", contextSlot: 11, validity: "valid", observedAt: NOW },
		},
	};
}

describe("MagicBlock MCP observer local E2E", () => {
	it("crosses MCP SDK, dispatcher, fake downstream, hosted ingress, and PGlite", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql });
		const provider = boundDelegationPost();
		let confirmedProof:
			| {
					status: "confirmed";
					cluster: "devnet";
					routerUrl: "https://devnet-router.magicblock.app/";
					signature: string;
					signer: string;
					slot: number;
					commitmentDigest: string;
					memo: string;
					verifiedAt: string;
			  }
			| undefined;
		let preparedTransaction: MagicBlockPreparedAuditTransaction | undefined;
		const verify = vi.fn(async () => {
			if (!confirmedProof) throw new Error("proof unavailable");
			return confirmedProof;
		});
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "observer-secret",
			runtime: {
				observations,
				auditRecords: createPgMagicBlockAuditRecordStore({ sql }),
					onchainAudit: {
					async register(details, onPrepared) {
						const commitment = materializeMagicBlockAuditCommitment(details);
						preparedTransaction = preparedAuditTransaction(details);
						await onPrepared?.(preparedTransaction);
						return (confirmedProof = {
							status: "confirmed",
							cluster: "devnet",
							routerUrl: "https://devnet-router.magicblock.app/",
							signature: preparedTransaction.signature,
							signer: preparedTransaction.signer,
							slot: 99,
							commitmentDigest: commitment.commitmentDigest,
							memo: commitment.memo,
							verifiedAt: NOW,
						});
					},
					verify,
				},
				createLedger: (binding) =>
					createPgMagicBlockAppendOnlyAuditLedger({
						sql,
						...binding,
						createAuditEventId: () => "aud_mcp_e2e",
						now: () => NOW,
					}),
				post: provider,
				now: () => NOW,
				createOpaqueId: (kind) => `${kind}-mcp-e2e`,
			},
		});
		let deliveredBody: unknown;
		const transport: MagicBlockMcpAuditTransport = vi.fn(async (url, init) => {
			const response = await ingress.handle(
				new Request(url, {
					method: init.method,
					headers: init.headers,
					body: init.body,
					signal: init.signal,
				}),
			);
			deliveredBody = await response.clone().json();
			return response;
		});
		const auditClient = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: "observer-secret",
			timeoutMs: 1_000,
			transport,
		});
		const successfulDownstream = fakeDownstream(
			downstreamResult("obs-mcp-e2e"),
		);
		const returned = await callThroughMcpProtocol({
			downstream: successfulDownstream,
			observer: createMagicBlockMcpObserver({ auditClient }),
		});
		expect(deliveredBody).toMatchObject({
			outcome: "review_required",
			audit: { registration: { status: "confirmed" } },
		});
		if (!preparedTransaction) throw new Error("prepared transaction expected");
		expect(JSON.stringify(deliveredBody)).not.toContain(
			preparedTransaction.serializedTransactionBase64,
		);

		expect(returned.structuredContent).toMatchObject({
			observationId: "obs-mcp-e2e",
			compassAudit: {
				outcome: "confirmed",
				audit: {
					audit: {
						registration: { status: "confirmed", slot: 99 },
					},
				},
			},
		});
		expect(successfulDownstream.listTools).toHaveBeenCalledTimes(1);
		expect(successfulDownstream.callTool).toHaveBeenCalledWith({
			toolName: "read_observation",
			arguments: { id: "controlled-e2e" },
		});
		expect(transport).toHaveBeenCalledTimes(1);
		expect(provider).toHaveBeenCalledTimes(2);
		const byAuditId = await ingress.handle(
			new Request(`${AUDIT_URL}?auditId=aud_mcp_e2e`, {
				headers: { Authorization: "Bearer observer-secret" },
			}),
		);
		expect(byAuditId.status).toBe(200);
		const byAuditIdBody = await byAuditId.json();
		expect(byAuditIdBody).toMatchObject({
			details: { auditEventId: "aud_mcp_e2e", observationId: "obs-mcp-e2e" },
			registration: { status: "confirmed", signature: preparedTransaction.signature },
		});
		expect(JSON.stringify(byAuditIdBody)).not.toContain(
			preparedTransaction.serializedTransactionBase64,
		);
		const bySignature = await ingress.handle(
			new Request(`${AUDIT_URL}?signature=${preparedTransaction.signature}`, {
				headers: { Authorization: "Bearer observer-secret" },
			}),
		);
		expect(bySignature.status).toBe(200);
		expect(verify).toHaveBeenCalledTimes(2);

		const wrongAuthClient = createMagicBlockHostedAuditClient({
			url: AUDIT_URL,
			apiKey: "wrong-observer-secret",
			timeoutMs: 1_000,
			transport,
		});
		const wrongAuthDownstream = fakeDownstream(
			downstreamResult("obs-mcp-wrong-auth"),
		);
		const wrongAuthReturned = await callThroughMcpProtocol({
			downstream: wrongAuthDownstream,
			observer: createMagicBlockMcpObserver({
				auditClient: wrongAuthClient,
			}),
		});

		expect(wrongAuthReturned.structuredContent).toMatchObject({
			observationId: "obs-mcp-wrong-auth",
			compassAudit: {
				outcome: "retryable_failure",
				retryable: true,
				code: "AUDIT_REJECTED",
			},
		});
		expect(transport).toHaveBeenCalledTimes(2);
		expect(provider).toHaveBeenCalledTimes(2);
		await expect(
			sql(
				`SELECT observation_id, status
				FROM magicblock_devnet_observations`,
				[],
			),
		).resolves.toEqual([
			{ observation_id: "obs-mcp-e2e", status: "completed" },
		]);
		await expect(
			sql(
				`SELECT audit_event_id, observation_id
				FROM magicblock_devnet_audit_ledger`,
				[],
			),
		).resolves.toEqual([
			{ audit_event_id: "aud_mcp_e2e", observation_id: "obs-mcp-e2e" },
		]);
	});
});

async function callThroughMcpProtocol(input: {
	readonly downstream: DownstreamMcpClient;
	readonly observer: ReturnType<typeof createMagicBlockMcpObserver>;
}): Promise<CallToolResult> {
	const server = createProxyMcpServer({
		downstream: input.downstream,
		executeTool: async (args) =>
			(await input.downstream.callTool(args)) as CallToolResult,
		observeMagicBlockObservation: input.observer,
	});
	const client = new Client({
		name: "magicblock-observer-e2e",
		version: "0.0.0",
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name)).toEqual([
			"read_observation",
		]);
		return (await client.callTool({
			name: "read_observation",
			arguments: { id: "controlled-e2e" },
		})) as CallToolResult;
	} finally {
		await client.close().catch(() => undefined);
		await server.close().catch(() => undefined);
	}
}

function fakeDownstream(result: CallToolResult): DownstreamMcpClient {
	return {
		isAvailable: true,
		listTools: vi.fn(async () => [
			{
				name: "read_observation",
				description: "Return one controlled unsigned transaction observation.",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
				descriptor: {
					name: "read_observation",
					description:
						"Return one controlled unsigned transaction observation.",
					inputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
					},
				},
			},
		]),
		callTool: vi.fn(async () => result),
	};
}

function downstreamResult(observationId: string): CallToolResult {
	return {
		content: [{ type: "text", text: "unsigned transaction built" }],
		structuredContent: {
			schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
			observationId,
			unsignedTransactionBase64: unsignedV0Transaction(),
		},
		isError: false,
	};
}

function unsignedV0Transaction(): string {
	return Buffer.from([
		1,
		...Array.from({ length: 64 }, () => 0),
		0x80,
		1,
		0,
		1,
		2,
		...Array.from({ length: 32 }, (_, index) => index + 1),
		...Array.from({ length: 32 }, (_, index) => index + 33),
		...Array.from({ length: 32 }, () => 7),
		1,
		1,
		1,
		0,
		0,
		0,
	]).toString("base64");
}

function boundDelegationPost(): MagicBlockPost {
	return vi.fn(async (request) => {
		const body = JSON.parse(request.body) as {
			id: number;
			params: [string];
		};
		expect(body.params).toHaveLength(1);
		expect(typeof body.params[0]).toBe("string");
		return {
			status: 200,
			url: request.url,
			redirected: false,
			body: JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						isDelegated: true,
					},
			}),
		};
	});
}

function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}
