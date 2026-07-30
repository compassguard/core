import {
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

import {
	createMagicBlockAuditSignerFromEnv,
	createMagicBlockOnchainAuditVerifier,
	createMagicBlockOnchainAuditSubmitter,
	createMagicBlockRouterRpc,
	deriveMagicBlockRoutingAccounts,
	materializeMagicBlockAuditCommitment,
} from "../magicBlockOnchainAudit";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_PREFIX,
	MAGICBLOCK_MEMO_PROGRAM_ID,
	type MagicBlockAuditCommitmentDetails,
	type MagicBlockRetryableAuditFailure,
	type MagicBlockRouterRpc,
} from "../magicBlockOnchainAuditContracts";
import { sanitizeMagicBlockRouterMessage } from "../magicBlockRouterDiagnostics";
import { MAGICBLOCK_ROUTER_URL } from "../magicBlockDevnetPreflightTypes";

const NOW = "2026-07-29T12:00:00.000Z";
const DETAILS: MagicBlockAuditCommitmentDetails = {
	schemaVersion: "compass.magicblock-audit-commitment/v1",
	cluster: "devnet",
	observationId: "obs-stable",
	auditEventId: "aud_stable",
	transactionDigest: "1".repeat(64),
	requestDigest: "2".repeat(64),
	resultDigest: "3".repeat(64),
	attestationDigest: "4".repeat(64),
	previousLedgerDigest: "5".repeat(64),
	ledgerDigest: "6".repeat(64),
	outcome: "review_required",
};

describe("MagicBlock devnet on-chain audit", () => {
	it("publishes the stable audit id and hash-chain metadata but no raw audit details", () => {
		const commitment = materializeMagicBlockAuditCommitment(DETAILS);

		expect(commitment.memo).toContain(MAGICBLOCK_AUDIT_COMMITMENT_PREFIX);
		expect(commitment.memo).toContain(DETAILS.auditEventId);
		expect(commitment.memo).toContain(DETAILS.previousLedgerDigest);
		expect(commitment.memo).toContain(DETAILS.ledgerDigest);
		expect(commitment.memo).toContain(commitment.commitmentDigest);
		expect(commitment.memo).not.toContain(DETAILS.requestDigest);
		expect(commitment.memo).not.toContain(DETAILS.transactionDigest);
		expect(commitment.memo).not.toContain(DETAILS.resultDigest);
		expect(commitment.memo.length).toBeLessThan(400);
	});

	it("uses the base-layer blockhash selected for the undelegated fee payer", async () => {
		const signer = Keypair.generate();
		const erBlockhash = Keypair.generate().publicKey.toBase58();
		const baseLayerBlockhash = Keypair.generate().publicKey.toBase58();
		let signature = "";
		let memo = "";
		const routerRpc: MagicBlockRouterRpc = vi.fn(async (method, params) => {
			if (method === "getBlockhashForAccounts") {
				expect(params).toEqual([[signer.publicKey.toBase58()]]);
				return {
					blockhash: baseLayerBlockhash,
					lastValidBlockHeight: 467_685_491,
				};
			}
			if (method === "sendTransaction") {
				const transaction = Transaction.from(
					Buffer.from(String(params[0]), "base64"),
				);
				signature = bs58.encode(transaction.signature as Buffer);
				expect(transaction.recentBlockhash).toBe(baseLayerBlockhash);
				expect(transaction.recentBlockhash).not.toBe(erBlockhash);
				expect(transaction.instructions[0]?.programId.toBase58()).toBe(
					MAGICBLOCK_MEMO_PROGRAM_ID,
				);
				memo = transaction.instructions[0]?.data.toString("utf8") ?? "";
				expect(transaction.feePayer?.toBase58()).toBe(signer.publicKey.toBase58());
				return signature;
			}
			throw new Error(`unexpected Router method ${method}`);
		});
		const solanaRpc: MagicBlockRouterRpc = vi.fn(async (method) => {
			if (method === "getSignatureStatuses") {
				return { value: [{ err: null, confirmationStatus: "confirmed" }] };
			}
			if (method === "getTransaction") {
				return {
					slot: 42,
					meta: { err: null },
					transaction: {
						message: {
							accountKeys: [
								signer.publicKey.toBase58(),
								MAGICBLOCK_MEMO_PROGRAM_ID,
							],
							header: { numRequiredSignatures: 1 },
							instructions: [
								{
									programIdIndex: 1,
									accounts: [0],
									data: bs58.encode(Buffer.from(memo, "utf8")),
								},
							],
						},
					},
				};
			}
			throw new Error(`unexpected Solana method ${method}`);
		});
		const submitter = createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc,
			solanaRpc,
			now: () => NOW,
			waitBetweenAttempts: async () => undefined,
		});

		const proof = await submitter.register(DETAILS);

		expect(proof).toMatchObject({
			status: "confirmed",
			signature,
			signer: signer.publicKey.toBase58(),
			slot: 42,
			verifiedAt: NOW,
		});
		expect(solanaRpc).toHaveBeenCalledWith("getTransaction", [
			signature,
			{ commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
		]);
		expect(routerRpc).not.toHaveBeenCalledWith(
			"getLatestBlockhash",
			expect.anything(),
		);
	});

	it("models an unconfirmed result as an explicit retryable failure", async () => {
		const signer = Keypair.generate();
		let signature = "";
		const routerRpc: MagicBlockRouterRpc = async (method, params) => {
			if (method === "getBlockhashForAccounts") {
				return {
					blockhash: Keypair.generate().publicKey.toBase58(),
					lastValidBlockHeight: 1,
				};
			}
			if (method === "sendTransaction") {
				signature = bs58.encode(
					Transaction.from(Buffer.from(String(params[0]), "base64"))
						.signature as Buffer,
				);
				return signature;
			}
			throw new Error("unexpected Router method");
		};
		const solanaRpc: MagicBlockRouterRpc = async () => {
			return { value: [{ err: null, confirmationStatus: "processed" }] };
		};

		const result = await createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc,
			solanaRpc,
			confirmationAttempts: 1,
		}).register(DETAILS);
		expect(result).toMatchObject({
			status: "retryable_failure",
			retryable: true,
			code: "SUBMISSION_UNCONFIRMED",
			signature,
		});
	});

	it("persists the prepared signature exactly once before sending that transaction", async () => {
		const signer = Keypair.generate();
		const events: string[] = [];
		let sentSignature = "";
		const routerRpc: MagicBlockRouterRpc = async (method, params) => {
			if (method === "getBlockhashForAccounts") {
				return {
					blockhash: Keypair.generate().publicKey.toBase58(),
					lastValidBlockHeight: 1,
				};
			}
			if (method === "sendTransaction") {
				events.push("send");
				sentSignature = bs58.encode(
					Transaction.from(Buffer.from(String(params[0]), "base64"))
						.signature as Buffer,
				);
				return sentSignature;
			}
			throw new Error(`unexpected Router method ${method}`);
		};
		const onPrepared = vi.fn(async (prepared: MagicBlockRetryableAuditFailure) => {
			events.push("prepared");
			expect(prepared.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
			return prepared;
		});
		const result = await createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc,
			solanaRpc: async () => ({
				value: [{ err: null, confirmationStatus: "processed" }],
			}),
			confirmationAttempts: 1,
		}).register(DETAILS, onPrepared);

		expect(events).toEqual(["prepared", "send"]);
		expect(onPrepared).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			status: "retryable_failure",
			code: "SUBMISSION_UNCONFIRMED",
			signature: sentSignature,
		});
	});

	it("does not send when another claimant already reserved a signature", async () => {
		const signer = Keypair.generate();
		const routerRpc: MagicBlockRouterRpc = vi.fn(async (method) => {
			if (method === "getBlockhashForAccounts") {
				return {
					blockhash: Keypair.generate().publicKey.toBase58(),
					lastValidBlockHeight: 1,
				};
			}
			throw new Error(`unexpected Router method ${method}`);
		});
		const result = await createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc,
			solanaRpc: vi.fn(),
		}).register(DETAILS, async (prepared) => ({
			...prepared,
			signature: "3".repeat(64),
		}));
		expect(result).toMatchObject({
			status: "retryable_failure",
			signature: "3".repeat(64),
		});
		expect(routerRpc).not.toHaveBeenCalledWith(
			"sendTransaction",
			expect.anything(),
		);
	});

	it("derives the fee payer plus every writable account once in transaction order", () => {
		const payer = Keypair.generate().publicKey;
		const writableA = Keypair.generate().publicKey;
		const writableB = Keypair.generate().publicKey;
		const readonly = Keypair.generate().publicKey;
		const transaction = new Transaction();
		transaction.feePayer = payer;
		transaction.add(
			new TransactionInstruction({
				programId: new PublicKey(MAGICBLOCK_MEMO_PROGRAM_ID),
				keys: [
					{ pubkey: writableA, isSigner: false, isWritable: true },
					{ pubkey: readonly, isSigner: false, isWritable: false },
					{ pubkey: payer, isSigner: true, isWritable: true },
					{ pubkey: writableB, isSigner: false, isWritable: true },
					{ pubkey: writableA, isSigner: false, isWritable: true },
				],
				data: Buffer.alloc(0),
			}),
		);

		expect(deriveMagicBlockRoutingAccounts(transaction)).toEqual([
			payer.toBase58(),
			writableA.toBase58(),
			writableB.toBase58(),
		]);
	});

	it.each([200, 400])(
		"preserves a bounded upstream preflight rejection with HTTP status %i",
		async (preflightHttpStatus) => {
		const signer = Keypair.generate();
		const baseLayerBlockhash = Keypair.generate().publicKey.toBase58();
		const secret = bs58.encode(Keypair.generate().secretKey);
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as {
				readonly method: string;
			};
			return {
				status:
					request.method === "getBlockhashForAccounts"
						? 200
						: preflightHttpStatus,
				redirected: false,
				url: MAGICBLOCK_ROUTER_URL,
				headers: new Headers({ "x-request-id": "router-request-123" }),
				async json() {
					return request.method === "getBlockhashForAccounts"
						? {
								result: {
									blockhash: baseLayerBlockhash,
									lastValidBlockHeight: 467_685_491,
								},
							}
						: {
								error: {
									code: -32002,
									message:
										`Transaction simulation failed: Blockhash not found; data: ${secret} ` +
										`https://untrusted.example/private ${"x".repeat(500)}`,
									unexpectedSecret: secret,
								},
								serializedTransaction: secret,
							};
				},
			} as Response;
		}) as typeof fetch;
		const result = await createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc: createMagicBlockRouterRpc(fetchImpl),
			solanaRpc: vi.fn(),
		}).register(DETAILS);

		expect(result).toMatchObject({
			status: "retryable_failure",
			retryable: true,
			code: "ROUTER_PREFLIGHT_REJECTED",
			routerDiagnostics: {
				rpcMethod: "sendTransaction",
				httpStatus: preflightHttpStatus,
				rpcErrorCode: -32002,
				message:
					"Transaction simulation failed: Blockhash not found; [details redacted]",
				requestId: "router-request-123",
			},
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("serializedTransaction");
		expect(serialized).not.toContain("unexpectedSecret");
		expect(serialized).not.toContain("untrusted.example");
		expect(result.status === "retryable_failure" &&
			result.routerDiagnostics?.message?.length).toBeLessThanOrEqual(240);
		},
	);

	it("sanitizes Router messages to allowlisted bounded text", () => {
		const secret = bs58.encode(Keypair.generate().secretKey);
		const message = sanitizeMagicBlockRouterMessage(
			`Simulation failed at https://untrusted.example/path ${"a".repeat(
				400,
			)} memo: ${secret}`,
		);

		expect(message?.length).toBeLessThanOrEqual(240);
		expect(message).not.toContain("https://");
		expect(message).not.toContain(secret);
		expect(message).not.toContain("memo:");
	});

	it("keeps confirmed status with null getTransaction as proof ambiguity", async () => {
		const expectedSigner = Keypair.generate().publicKey.toBase58();
		const rpc: MagicBlockRouterRpc = async (method) => {
			if (method === "getSignatureStatuses") {
				return { value: [{ err: null, confirmationStatus: "confirmed" }] };
			}
			if (method === "getTransaction") return null;
			throw new Error(`unexpected method ${method}`);
		};

		await expect(
			createMagicBlockOnchainAuditVerifier({
				rpc,
				now: () => NOW,
				confirmationAttempts: 1,
			}).verify({
				signature: "3".repeat(64),
				expectedSigner,
			}),
		).resolves.toMatchObject({
			status: "retryable_failure",
			code: "TRANSACTION_VERIFICATION_FAILED",
		});
	});

	it("verifies with the stored public signer without a current secret", async () => {
		const storedSigner = Keypair.generate().publicKey.toBase58();
		const rotatedSigner = Keypair.generate().publicKey.toBase58();
		const commitment = materializeMagicBlockAuditCommitment(DETAILS);
		const rpc: MagicBlockRouterRpc = async (method) => {
			if (method === "getSignatureStatuses") {
				return { value: [{ err: null, confirmationStatus: "confirmed" }] };
			}
			if (method === "getTransaction") {
				return {
					slot: 84,
					meta: { err: null },
					transaction: {
						message: {
							accountKeys: [storedSigner, MAGICBLOCK_MEMO_PROGRAM_ID],
							header: { numRequiredSignatures: 1 },
							instructions: [
								{
									programIdIndex: 1,
									accounts: [0],
									data: bs58.encode(
										Buffer.from(commitment.memo, "utf8"),
									),
								},
							],
						},
					},
				};
			}
			throw new Error(`unexpected method ${method}`);
		};
		const verifier = createMagicBlockOnchainAuditVerifier({
			rpc,
			now: () => NOW,
			confirmationAttempts: 1,
		});

		await expect(
			verifier.verify({
				signature: "4".repeat(64),
				expectedSigner: storedSigner,
				expectedCommitmentDigest: commitment.commitmentDigest,
				expectedMemo: commitment.memo,
			}),
		).resolves.toMatchObject({
			status: "confirmed",
			signer: storedSigner,
			slot: 84,
		});
		await expect(
			verifier.verify({
				signature: "4".repeat(64),
				expectedSigner: rotatedSigner,
				expectedCommitmentDigest: commitment.commitmentDigest,
				expectedMemo: commitment.memo,
			}),
		).resolves.toMatchObject({
			status: "retryable_failure",
			code: "TRANSACTION_VERIFICATION_FAILED",
		});
	});

	it("classifies an explicit signature status error as execution failure", async () => {
		const rpc: MagicBlockRouterRpc = async (method) => {
			if (method === "getSignatureStatuses") {
				return {
					value: [
						{
							err: { InstructionError: [0, "InvalidArgument"] },
							confirmationStatus: "confirmed",
						},
					],
				};
			}
			throw new Error(`unexpected method ${method}`);
		};

		await expect(
			createMagicBlockOnchainAuditVerifier({
				rpc,
				confirmationAttempts: 1,
			}).verify({
				signature: "5".repeat(64),
				expectedSigner: Keypair.generate().publicKey.toBase58(),
			}),
		).resolves.toMatchObject({
			status: "retryable_failure",
			code: "TRANSACTION_EXECUTION_FAILED",
			signature: "5".repeat(64),
		});
	});

	it("loads only the dedicated devnet audit signer and verifies its public key", () => {
		const signer = Keypair.generate();
		const env = new Map([
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY",
				bs58.encode(signer.secretKey),
			],
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY",
				signer.publicKey.toBase58(),
			],
		]);
		expect(
			createMagicBlockAuditSignerFromEnv((key) => env.get(key))?.publicKey.toBase58(),
		).toBe(signer.publicKey.toBase58());
		expect(
			createMagicBlockAuditSignerFromEnv((key) =>
				key.endsWith("PUBLIC_KEY") ? Keypair.generate().publicKey.toBase58() : env.get(key),
			),
		).toBeNull();
	});

	it("loads the safer absolute signer-file variant without exposing its bytes", () => {
		const signer = Keypair.generate();
		const env = new Map([
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE",
				"/tmp/compass-audit-keypair.json",
			],
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY",
				signer.publicKey.toBase58(),
			],
		]);
		const loaded = createMagicBlockAuditSignerFromEnv(
			(key) => env.get(key),
			() => JSON.stringify([...signer.secretKey]),
		);
		expect(loaded?.publicKey.toBase58()).toBe(signer.publicKey.toBase58());
	});

	it("rejects ambiguous dual signer configuration", () => {
		const signer = Keypair.generate();
		const env = new Map([
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY",
				bs58.encode(signer.secretKey),
			],
			[
				"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE",
				"/tmp/compass-audit-keypair.json",
			],
		]);
		expect(
			createMagicBlockAuditSignerFromEnv(
				(key) => env.get(key),
				() => JSON.stringify([...signer.secretKey]),
			),
		).toBeNull();
	});
});
