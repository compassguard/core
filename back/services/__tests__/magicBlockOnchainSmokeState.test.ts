import {
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createMagicBlockOnchainAuditSubmitter,
} from "../magicBlockOnchainAudit";
import type {
	MagicBlockAuditCommitmentDetails,
	MagicBlockRouterRpc,
} from "../magicBlockOnchainAuditContracts";
import {
	consumeMagicBlockSmokeAuthorization,
	classifyMagicBlockSmokeReconciliation,
	createMagicBlockSmokeAuthorization,
	persistPreparedMagicBlockSmoke,
	readMagicBlockSmokeState,
	reconcileMagicBlockSmoke,
} from "../../../scripts/magicBlockDevnetSmokeState";

const NOW = "2026-07-29T12:00:00.000Z";
const DETAILS: MagicBlockAuditCommitmentDetails = {
	schemaVersion: "compass.magicblock-audit-commitment/v1",
	cluster: "devnet",
	observationId: "obs-smoke-state",
	auditEventId: "aud_smoke_state",
	transactionDigest: "1".repeat(64),
	requestDigest: "2".repeat(64),
	resultDigest: "3".repeat(64),
	attestationDigest: "4".repeat(64),
	previousLedgerDigest: "5".repeat(64),
	ledgerDigest: "6".repeat(64),
	outcome: "review_required",
};
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("MagicBlock direct-smoke durable state", () => {
	it("atomically consumes a one-run authorization and blocks reuse", () => {
		const stateDirectory = createStateDirectory();
		createMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce: "authorization-nonce-0001",
			createdAt: NOW,
		});
		const active = consumeMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce: "authorization-nonce-0001",
			auditEventId: "aud_smoke_once",
			observationId: "obs-smoke-once",
			startedAt: NOW,
		});

		expect(active.status).toBe("active");
		expect(() =>
			consumeMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-0001",
				auditEventId: "aud_smoke_twice",
				observationId: "obs-smoke-twice",
				startedAt: NOW,
			}),
		).toThrow("authorization unavailable");
		expect(() =>
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-0002",
				createdAt: NOW,
			}),
		).toThrow("requires reconciliation");
	});

	it("reconciles an active pre-prepare crash as not submitted before reauthorization", () => {
		const stateDirectory = createStateDirectory();
		createMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce: "authorization-nonce-active",
			createdAt: NOW,
		});
		consumeMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce: "authorization-nonce-active",
			auditEventId: "aud_smoke_active",
			observationId: "obs-smoke-active",
			startedAt: NOW,
		});

		expect(
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "not_submitted",
				reconciledAt: NOW,
			}),
		).toMatchObject({ status: "reconciled", outcome: "not_submitted" });
		expect(
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-after-active",
				createdAt: NOW,
			}),
		).toMatchObject({
			status: "authorized",
			authorizationNonce: "authorization-nonce-after-active",
		});
	});

	it("persists prepared evidence before send and refuses a new send after response loss", async () => {
		const stateDirectory = createStateDirectory();
		const signer = Keypair.generate();
		const signerSecret = bs58.encode(signer.secretKey);
		const authorizationNonce = "authorization-nonce-crash-window";
		createMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce,
			createdAt: NOW,
		});
		consumeMagicBlockSmokeAuthorization({
			stateDirectory,
			authorizationNonce,
			auditEventId: DETAILS.auditEventId,
			observationId: DETAILS.observationId,
			startedAt: NOW,
		});
		let serializedTransaction = "";
		const routerRpc: MagicBlockRouterRpc = vi.fn(async (method, params) => {
			if (method === "getBlockhashForAccounts") {
				return {
					blockhash: Keypair.generate().publicKey.toBase58(),
					lastValidBlockHeight: 1,
				};
			}
			if (method === "sendTransaction") {
				serializedTransaction = String(params[0]);
				const transaction = Transaction.from(
					Buffer.from(serializedTransaction, "base64"),
				);
				const prepared = readMagicBlockSmokeState(stateDirectory);
				expect(prepared).toMatchObject({
					status: "pending",
					signature: bs58.encode(transaction.signature as Buffer),
				});
				throw new Error("simulated response loss after send");
			}
			throw new Error(`unexpected method ${method}`);
		});
		const registration = await createMagicBlockOnchainAuditSubmitter({
			signer,
			routerRpc,
			solanaRpc: vi.fn(),
		}).register(DETAILS, async (prepared) => {
			persistPreparedMagicBlockSmoke({
				stateDirectory,
				authorizationNonce,
				signer: signer.publicKey.toBase58(),
				prepared,
				preparedAt: NOW,
			});
			return prepared;
		});

		expect(registration).toMatchObject({
			status: "retryable_failure",
			code: "ROUTER_UNAVAILABLE",
		});
		const pending = readMagicBlockSmokeState(stateDirectory);
		expect(pending).toMatchObject({
			status: "pending",
			auditEventId: DETAILS.auditEventId,
			observationId: DETAILS.observationId,
			signer: signer.publicKey.toBase58(),
		});
		const persisted = readFileSync(join(stateDirectory, "state.json"), "utf8");
		expect(persisted).not.toContain(serializedTransaction);
		expect(persisted).not.toContain(signerSecret);
		expect(() =>
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-blocked",
				createdAt: NOW,
			}),
		).toThrow("requires reconciliation");

		if (pending?.status !== "pending") {
			throw new Error("test expected pending smoke state");
		}
		const proofAmbiguity = {
			status: "retryable_failure" as const,
			retryable: true as const,
			code: "TRANSACTION_VERIFICATION_FAILED" as const,
		};
		expect(
			classifyMagicBlockSmokeReconciliation(
				proofAmbiguity,
				proofAmbiguity,
			),
		).toBeNull();
		expect(() =>
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-still-blocked",
				createdAt: NOW,
			}),
		).toThrow("requires reconciliation");
		const explicitExecutionFailure = {
			status: "retryable_failure" as const,
			retryable: true as const,
			code: "TRANSACTION_EXECUTION_FAILED" as const,
			signature: pending.signature,
		};
		expect(
			classifyMagicBlockSmokeReconciliation(
				explicitExecutionFailure,
				explicitExecutionFailure,
			),
		).toBe("failed");
		reconcileMagicBlockSmoke({
			stateDirectory,
			outcome: "failed",
			signature: pending.signature,
			reconciledAt: NOW,
		});
		expect(
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-after-reconcile",
				createdAt: NOW,
			}),
		).toMatchObject({ status: "authorized" });
	});
});

function createStateDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "compass-magicblock-smoke-"));
	directories.push(directory);
	return directory;
}
