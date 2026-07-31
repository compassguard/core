import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	Keypair,
	SystemProgram,
	Transaction,
} from "@solana/web3.js";
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
	collectMagicBlockSmokeEndpointExpiryEvidence,
	createMagicBlockSmokeAuthorization,
	importLegacyMagicBlockTransactionEvidence,
	persistPreparedMagicBlockSmoke,
	readMagicBlockSmokeState,
	reconcileMagicBlockSmoke,
} from "../../../scripts/magicBlockDevnetSmokeState";
import {
	MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
	MAGICBLOCK_SMOKE_STATE_SCHEMA,
} from "../../../scripts/magicBlockDevnetSmokeStateContracts";

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
				recentBlockhash: transaction.recentBlockhash,
				lastValidBlockHeight: 1,
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

	it("reads the exact historical v1 pending shape as blocking legacy evidence", () => {
		const stateDirectory = createStateDirectory();
		const signer = Keypair.generate();
		writeFileSync(
			join(stateDirectory, "state.json"),
			`${JSON.stringify({
				schemaVersion: "compass.magicblock-devnet-smoke-state/v1",
				status: "pending",
				authorizationNonce: "authorization-nonce-historical",
				auditEventId: "aud_historical",
				observationId: "obs-historical",
				signer: signer.publicKey.toBase58(),
				signature: "2".repeat(64),
				commitmentDigest: "3".repeat(64),
				memo: "compass:audit:v1:{}",
				preparedAt: NOW,
			})}\n`,
		);

		expect(readMagicBlockSmokeState(stateDirectory)).toEqual({
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "legacy_pending",
			signer: signer.publicKey.toBase58(),
			signature: "2".repeat(64),
			importedAt: NOW,
			sourceSchemaVersion: "compass.magicblock-devnet-smoke-state/v1",
			originalEvidence: {
				authorizationNonce: "authorization-nonce-historical",
				auditEventId: "aud_historical",
				observationId: "obs-historical",
				commitmentDigest: "3".repeat(64),
				memo: "compass:audit:v1:{}",
				preparedAt: NOW,
			},
		});
		expect(() =>
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-must-stay-blocked",
				createdAt: NOW,
			}),
		).toThrow("requires reconciliation");
	});

	it("keeps the incident legacy_pending v1 state blocking without evidence", () => {
		const stateDirectory = createStateDirectory();
		writeFileSync(
			join(stateDirectory, "state.json"),
			`${JSON.stringify({
				schemaVersion: "compass.magicblock-devnet-smoke-state/v1",
				status: "legacy_pending",
				signer: "Fpp49ehhybJpUTqQaYingNhnWiQQAVcfcqFQAyL4pVV7",
				signature:
					"56qrw6n6eYdYbobzF3qAdF9n7QYvRe2ZePrpvT6NSnrfAGqgLP1HzE1cXVNMaF3TJgDTDNHDh9UNcwxXACnTKUVT",
				importedAt: NOW,
			})}\n`,
		);

		expect(readMagicBlockSmokeState(stateDirectory)).toMatchObject({
			status: "legacy_pending",
			signer: "Fpp49ehhybJpUTqQaYingNhnWiQQAVcfcqFQAyL4pVV7",
			signature:
				"56qrw6n6eYdYbobzF3qAdF9n7QYvRe2ZePrpvT6NSnrfAGqgLP1HzE1cXVNMaF3TJgDTDNHDh9UNcwxXACnTKUVT",
			importedAt: NOW,
			sourceSchemaVersion: "compass.magicblock-devnet-smoke-state/v1",
		});
		expect(() =>
			createMagicBlockSmokeAuthorization({
				stateDirectory,
				authorizationNonce: "authorization-nonce-incident-blocked",
				createdAt: NOW,
			}),
		).toThrow("requires reconciliation");
	});

	it("cryptographically enriches legacy evidence without retaining transaction bytes or closing", () => {
		const stateDirectory = createStateDirectory();
		const signer = Keypair.generate();
		const transaction = new Transaction({
			feePayer: signer.publicKey,
			recentBlockhash: Keypair.generate().publicKey.toBase58(),
		}).add(
			SystemProgram.transfer({
				fromPubkey: signer.publicKey,
				toPubkey: Keypair.generate().publicKey,
				lamports: 1,
			}),
		);
		transaction.sign(signer);
		const encoded = transaction.serialize().toString("base64");
		const signature = bs58.encode(transaction.signature as Buffer);
		writeFileSync(
			join(stateDirectory, "state.json"),
			`${JSON.stringify({
				schemaVersion: "compass.magicblock-devnet-smoke-state/v1",
				status: "legacy_pending",
				signer: signer.publicKey.toBase58(),
				signature,
				importedAt: NOW,
			})}\n`,
		);
		const evidenceFile = join(
			createStateDirectory(),
			"signed-transaction.base64",
		);
		writeFileSync(evidenceFile, encoded);

		const enriched = importLegacyMagicBlockTransactionEvidence({
			stateDirectory,
			evidenceFile,
			authorizationId: "incident-authorization-001",
			operator: "operator@example.test",
			reason: "Recover signature-bound expiry evidence",
			authorizedAt: NOW,
			riskAcknowledgement:
				MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
			importedAt: NOW,
		});

		expect(enriched).toMatchObject({
			status: "legacy_pending",
			signer: signer.publicKey.toBase58(),
			signature,
			evidenceImport: {
				authorizationId: "incident-authorization-001",
				operator: "operator@example.test",
				reason: "Recover signature-bound expiry evidence",
				recentBlockhash: transaction.recentBlockhash,
			},
		});
		const persisted = readFileSync(join(stateDirectory, "state.json"), "utf8");
		expect(persisted).not.toContain(encoded);
		expect(persisted).not.toContain(bs58.encode(signer.secretKey));
		expect(() =>
			importLegacyMagicBlockTransactionEvidence({
				stateDirectory,
				evidenceFile,
				authorizationId: "incident-authorization-replay",
				operator: "operator@example.test",
				reason: "Replay",
				authorizedAt: NOW,
				riskAcknowledgement:
					MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
				importedAt: NOW,
			}),
		).toThrow("import unavailable");
		expect(readMagicBlockSmokeState(stateDirectory)?.status).toBe(
			"legacy_pending",
		);
	});

	it("rejects symlinked evidence and canonical aliases within the state directory", () => {
		const stateDirectory = createStateDirectory();
		const signer = Keypair.generate();
		const transaction = new Transaction({
			feePayer: signer.publicKey,
			recentBlockhash: Keypair.generate().publicKey.toBase58(),
		}).add(
			SystemProgram.transfer({
				fromPubkey: signer.publicKey,
				toPubkey: Keypair.generate().publicKey,
				lamports: 1,
			}),
		);
		transaction.sign(signer);
		const encoded = transaction.serialize().toString("base64");
		writeFileSync(
			join(stateDirectory, "state.json"),
			`${JSON.stringify({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "legacy_pending",
				signer: signer.publicKey.toBase58(),
				signature: bs58.encode(transaction.signature as Buffer),
				importedAt: NOW,
				sourceSchemaVersion: "compass.magicblock-devnet-smoke-state/v1",
			})}\n`,
		);
		const externalEvidence = join(
			createStateDirectory(),
			"signed-transaction.base64",
		);
		writeFileSync(externalEvidence, encoded);
		const symlinkedEvidence = join(
			createStateDirectory(),
			"linked-transaction.base64",
		);
		symlinkSync(externalEvidence, symlinkedEvidence);

		expect(() =>
			importLegacyMagicBlockTransactionEvidence({
				stateDirectory,
				evidenceFile: symlinkedEvidence,
				authorizationId: "incident-authorization-symlink",
				operator: "operator@example.test",
				reason: "Reject symlinked evidence",
				authorizedAt: NOW,
				riskAcknowledgement:
					MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
				importedAt: NOW,
			}),
		).toThrow("legacy evidence file unavailable");

		const inStateEvidence = join(stateDirectory, "signed-transaction.base64");
		writeFileSync(inStateEvidence, encoded);
		const stateAlias = join(createStateDirectory(), "state-alias");
		symlinkSync(stateDirectory, stateAlias);
		expect(() =>
			importLegacyMagicBlockTransactionEvidence({
				stateDirectory: stateAlias,
				evidenceFile: inStateEvidence,
				authorizationId: "incident-authorization-alias",
				operator: "operator@example.test",
				reason: "Reject state path alias",
				authorizedAt: NOW,
				riskAcknowledgement:
					MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
				importedAt: NOW,
			}),
		).toThrow("legacy evidence file unavailable");
	});

	it("fails closed on dual-endpoint disagreement and missing expiry evidence", () => {
		const confirmed = {
			status: "confirmed" as const,
			cluster: "devnet" as const,
			routerUrl: "https://devnet-router.magicblock.app/" as const,
			signature: "2".repeat(64),
			signer: Keypair.generate().publicKey.toBase58(),
			slot: 1,
			commitmentDigest: "3".repeat(64),
			memo: "compass:audit:v1:{}",
			verifiedAt: NOW,
		};
		const absent = {
			status: "retryable_failure" as const,
			retryable: true as const,
			code: "SUBMISSION_UNCONFIRMED" as const,
			signature: confirmed.signature,
		};
		const disagreementBlockhash = Keypair.generate().publicKey.toBase58();
		expect(
			classifyMagicBlockSmokeReconciliation(confirmed, absent, {
				solana: endpointEvidence(
					"solana_devnet",
					confirmed.signature,
					disagreementBlockhash,
					"present",
				),
				magicRouter: endpointEvidence(
					"magic_router",
					confirmed.signature,
					disagreementBlockhash,
				),
			}),
		).toBeNull();
		expect(
			classifyMagicBlockSmokeReconciliation(absent, absent),
		).toBeNull();
	});

	it("closes only on independent expired-and-not-landed proof and replays idempotently", () => {
		const stateDirectory = createPreparedState();
		const state = readMagicBlockSmokeState(stateDirectory);
		if (state?.status !== "pending") throw new Error("expected pending");
		const absent = {
			status: "retryable_failure" as const,
			retryable: true as const,
			code: "SUBMISSION_UNCONFIRMED" as const,
			signature: state.signature,
		};
		expect(() =>
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "expired_not_landed",
				signature: state.signature,
				reconciledAt: NOW,
			}),
		).toThrow("ambiguous");
		const expiryEvidence = {
			solana: endpointEvidence(
				"solana_devnet",
				state.signature,
				state.recentBlockhash,
				"not_found",
				101,
			),
			magicRouter: endpointEvidence(
				"magic_router",
				state.signature,
				state.recentBlockhash,
				"not_found",
				102,
			),
		};
		const outcome = classifyMagicBlockSmokeReconciliation(absent, absent, {
			...expiryEvidence,
			lastValidBlockHeight: 100,
		});
		expect(outcome).toBe("expired_not_landed");
		const first = reconcileMagicBlockSmoke({
			stateDirectory,
			outcome: "expired_not_landed",
			signature: state.signature,
			reconciledAt: NOW,
			expiryEvidence,
		});
		expect(
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "expired_not_landed",
				signature: state.signature,
				reconciledAt: NOW,
				expiryEvidence,
			}),
		).toEqual(first);
		expect(() =>
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "confirmed",
				signature: state.signature,
				reconciledAt: NOW,
			}),
		).toThrow("conflicts");
	});

	it("returns only bounded enums and heights from endpoint expiry diagnostics", async () => {
		const signature = "2".repeat(64);
		const blockhash = Keypair.generate().publicKey.toBase58();
		const calls: string[] = [];
		const rpc: MagicBlockRouterRpc = vi.fn(async (method) => {
			calls.push(method);
			if (method === "getSignatureStatuses") {
				return { context: { slot: 501 }, value: [null] };
			}
			if (method === "isBlockhashValid") {
				return { context: { slot: 500 }, value: false };
			}
			if (method === "getBlockHeight") return 101;
			throw new Error("secret serialized transaction");
		});
		await expect(
			collectMagicBlockSmokeEndpointExpiryEvidence(
				rpc,
				"solana_devnet",
				signature,
				blockhash,
				() => NOW,
			),
		).resolves.toEqual({
			endpoint: "solana_devnet",
			signature,
			recentBlockhash: blockhash,
			commitment: "finalized",
			signatureStatus: "not_found",
			blockhashValidity: "invalid",
			expiryContextSlot: 500,
			signatureContextSlot: 501,
			blockHeight: 101,
			observedAt: NOW,
		});
		expect(calls).toEqual([
			"isBlockhashValid",
			"getBlockHeight",
			"getSignatureStatuses",
		]);
	});

	it("rejects a landing race and swapped bound evidence", () => {
		const stateDirectory = createPreparedState();
		const state = readMagicBlockSmokeState(stateDirectory);
		if (state?.status !== "pending") throw new Error("expected pending");
		const stale = {
			solana: endpointEvidence(
				"solana_devnet",
				state.signature,
				state.recentBlockhash,
				"not_found",
				101,
				499,
			),
			magicRouter: endpointEvidence(
				"magic_router",
				state.signature,
				state.recentBlockhash,
				"not_found",
				102,
			),
		};
		expect(() =>
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "expired_not_landed",
				signature: state.signature,
				reconciledAt: NOW,
				expiryEvidence: stale,
			}),
		).toThrow("ambiguous");
		const swapped = {
			solana: endpointEvidence(
				"solana_devnet",
				state.signature,
				Keypair.generate().publicKey.toBase58(),
			),
			magicRouter: endpointEvidence(
				"magic_router",
				"3".repeat(64),
				state.recentBlockhash,
			),
		};
		expect(() =>
			reconcileMagicBlockSmoke({
				stateDirectory,
				outcome: "expired_not_landed",
				signature: state.signature,
				reconciledAt: NOW,
				expiryEvidence: swapped,
			}),
		).toThrow("ambiguous");
	});
});

function createStateDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "compass-magicblock-smoke-"));
	directories.push(directory);
	return directory;
}

function createPreparedState(): string {
	const stateDirectory = createStateDirectory();
	const signer = Keypair.generate();
	const authorizationNonce = "authorization-nonce-prepared-fixture";
	createMagicBlockSmokeAuthorization({
		stateDirectory,
		authorizationNonce,
		createdAt: NOW,
	});
	consumeMagicBlockSmokeAuthorization({
		stateDirectory,
		authorizationNonce,
		auditEventId: "aud-prepared-fixture",
		observationId: "obs-prepared-fixture",
		startedAt: NOW,
	});
	persistPreparedMagicBlockSmoke({
		stateDirectory,
		authorizationNonce,
		signer: signer.publicKey.toBase58(),
		prepared: {
			status: "retryable_failure",
			retryable: true,
			code: "SUBMISSION_UNCONFIRMED",
			signature: "2".repeat(64),
			commitmentDigest: "3".repeat(64),
			memo: "compass:audit:v1:{}",
			recentBlockhash: Keypair.generate().publicKey.toBase58(),
			lastValidBlockHeight: 100,
		},
		preparedAt: NOW,
	});
	return stateDirectory;
}

function endpointEvidence(
	endpoint: "solana_devnet" | "magic_router",
	signature: string,
	recentBlockhash: string,
	signatureStatus: "not_found" | "present" = "not_found",
	blockHeight = 101,
	signatureContextSlot = 501,
) {
	return {
		endpoint,
		signature,
		recentBlockhash,
		commitment: "finalized" as const,
		signatureStatus,
		blockhashValidity: "invalid" as const,
		expiryContextSlot: 500,
		signatureContextSlot,
		blockHeight,
		observedAt: NOW,
	};
}
