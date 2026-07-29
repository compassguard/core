import { Keypair, Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

import {
	createMagicBlockAuditSignerFromEnv,
	createMagicBlockOnchainAuditSubmitter,
	materializeMagicBlockAuditCommitment,
	type MagicBlockRouterRpc,
} from "../magicBlockOnchainAudit";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_PREFIX,
	MAGICBLOCK_MEMO_PROGRAM_ID,
	type MagicBlockAuditCommitmentDetails,
} from "../magicBlockOnchainAuditContracts";

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

	it("signs a standard Memo transaction, confirms it, and verifies getTransaction", async () => {
		const signer = Keypair.generate();
		let signature = "";
		let memo = "";
		const routerRpc: MagicBlockRouterRpc = vi.fn(async (method, params) => {
			if (method === "getLatestBlockhash") {
				return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
			}
			if (method === "sendTransaction") {
				const transaction = Transaction.from(
					Buffer.from(String(params[0]), "base64"),
				);
				signature = bs58.encode(transaction.signature as Buffer);
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
	});

	it("models an unconfirmed result as an explicit retryable failure", async () => {
		const signer = Keypair.generate();
		let signature = "";
		const routerRpc: MagicBlockRouterRpc = async (method, params) => {
			if (method === "getLatestBlockhash") {
				return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
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

	it("does not send when another claimant already reserved a signature", async () => {
		const signer = Keypair.generate();
		const routerRpc: MagicBlockRouterRpc = vi.fn(async (method) => {
			if (method === "getLatestBlockhash") {
				return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
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
