import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import type {
	MagicBlockOnchainAuditRegistration,
	MagicBlockPreparedAuditTransaction,
	MagicBlockRouterRpc,
} from "../back/services/magicBlockOnchainAuditContracts";
import {
	MAGICBLOCK_SMOKE_STATE_SCHEMA,
	MAGICBLOCK_SMOKE_STATE_SCHEMA_V1,
	MAGICBLOCK_SMOKE_STATE_SCHEMA_V2,
	MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
	MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT,
	MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON,
	type MagicBlockSmokeActiveState,
	type MagicBlockSmokeAuthorizedState,
	type MagicBlockSmokeLegacyPendingState,
	type MagicBlockSmokePendingState,
	type MagicBlockSmokeQuarantinedState,
	type MagicBlockSmokeQuarantineEndpointObservation,
	type MagicBlockSmokeReconciledState,
	type MagicBlockSmokeEndpointExpiryEvidence,
	type MagicBlockSmokeState,
} from "./magicBlockDevnetSmokeStateContracts";

const STATE_FILE = "state.json";
const LOCK_FILE = "state.lock";
const MAX_STATE_BYTES = 16_384;
const MAX_EVIDENCE_BYTES = 4_096;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_NONCE = /^[A-Za-z0-9._:-]{16,128}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const BLOCKHASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SAFE_TEXT = /^[\x20-\x7e]{1,256}$/;

export function createMagicBlockSmokeAuthorization(input: {
	readonly stateDirectory: string;
	readonly authorizationNonce: string;
	readonly createdAt: string;
}): MagicBlockSmokeAuthorizedState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current && current.status !== "reconciled") {
			if (current.status !== "quarantined") {
				throw new Error("MagicBlock smoke state requires reconciliation");
			}
		}
		if (current?.status === "reconciled" || current?.status === "quarantined") {
			archiveInactiveState(input.stateDirectory, current);
		}
		const state: MagicBlockSmokeAuthorizedState = {
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "authorized",
			authorizationNonce: requireNonce(input.authorizationNonce),
			createdAt: requireTimestamp(input.createdAt),
		};
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function consumeMagicBlockSmokeAuthorization(input: {
	readonly stateDirectory: string;
	readonly authorizationNonce: string;
	readonly auditEventId: string;
	readonly observationId: string;
	readonly startedAt: string;
}): MagicBlockSmokeActiveState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (
			current?.status !== "authorized" ||
			current.authorizationNonce !== requireNonce(input.authorizationNonce)
		) {
			throw new Error("MagicBlock smoke authorization unavailable");
		}
		const state: MagicBlockSmokeActiveState = {
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "active",
			authorizationNonce: current.authorizationNonce,
			auditEventId: requireId(input.auditEventId),
			observationId: requireId(input.observationId),
			startedAt: requireTimestamp(input.startedAt),
		};
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function persistPreparedMagicBlockSmoke(input: {
	readonly stateDirectory: string;
	readonly authorizationNonce: string;
	readonly signer: string;
	readonly prepared: MagicBlockPreparedAuditTransaction;
	readonly preparedAt: string;
}): MagicBlockSmokePendingState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (
			current?.status !== "active" ||
			current.authorizationNonce !== requireNonce(input.authorizationNonce) ||
			input.prepared.schemaVersion !==
				"compass.magicblock-prepared-audit-transaction/v1" ||
			input.prepared.signer !== input.signer
		) {
			throw new Error("MagicBlock prepared smoke unavailable");
		}
		const state: MagicBlockSmokePendingState = {
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "pending",
			cluster: "devnet",
			lane: "magicblock_devnet_audit_memo",
			valueTransferLamports: 0,
			authorizationNonce: current.authorizationNonce,
			auditEventId: current.auditEventId,
			observationId: current.observationId,
			signer: requireSigner(input.signer),
			signature: requireSignature(input.prepared.signature),
			commitmentDigest: requireDigest(input.prepared.commitmentDigest),
			memo: requireMemo(input.prepared.memo),
			recentBlockhash: requireBlockhash(input.prepared.recentBlockhash),
			lastValidBlockHeight: requireBlockHeight(
				input.prepared.lastValidBlockHeight,
			),
			serializedTransactionBase64:
				requireSerializedTransactionBase64(
					input.prepared.serializedTransactionBase64,
				),
			serializedTransactionDigest: requireDigest(
				input.prepared.serializedTransactionDigest,
			),
			blockhashValidityEvidence: validateBlockhashValidityEvidence(
				input.prepared.blockhashValidityEvidence,
				input.prepared.recentBlockhash,
			),
			preparedAt: requireTimestamp(input.preparedAt),
		};
		validatePreparedTransactionBinding(state);
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function importLegacyPendingMagicBlockSmoke(input: {
	readonly stateDirectory: string;
	readonly signer: string;
	readonly signature: string;
	readonly importedAt: string;
}): MagicBlockSmokeLegacyPendingState {
	return withStateLock(input.stateDirectory, () => {
		if (readMagicBlockSmokeStateUnlocked(input.stateDirectory)) {
			throw new Error("MagicBlock smoke state already exists");
		}
		const state: MagicBlockSmokeLegacyPendingState = {
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "legacy_pending",
			signer: requireSigner(input.signer),
			signature: requireSignature(input.signature),
			importedAt: requireTimestamp(input.importedAt),
			sourceSchemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA_V1,
		};
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function importLegacyMagicBlockTransactionEvidence(input: {
	readonly stateDirectory: string;
	readonly evidenceFile: string;
	readonly authorizationId: string;
	readonly operator: string;
	readonly reason: string;
	readonly authorizedAt: string;
	readonly riskAcknowledgement: string;
	readonly importedAt: string;
}): MagicBlockSmokeLegacyPendingState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current?.status !== "legacy_pending" || current.evidenceImport) {
			throw new Error("MagicBlock legacy evidence import unavailable");
		}
		const evidencePath = requireEvidenceFile(
			input.evidenceFile,
			input.stateDirectory,
		);
		const stats = statSync(evidencePath);
		if (!stats.isFile() || stats.size < 1 || stats.size > MAX_EVIDENCE_BYTES) {
			throw new Error("MagicBlock legacy evidence unavailable");
		}
		const encoded = readFileSync(evidencePath, "utf8").trim();
		if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) {
			throw new Error("MagicBlock legacy evidence unavailable");
		}
		let serialized: Buffer;
		let transaction: Transaction;
		try {
			serialized = Buffer.from(encoded, "base64");
			if (
				serialized.length < 1 ||
				serialized.toString("base64") !== encoded ||
				serialized.length > MAX_EVIDENCE_BYTES
			) {
				throw new Error("invalid");
			}
			transaction = Transaction.from(serialized);
		} catch {
			throw new Error("MagicBlock legacy evidence unavailable");
		}
		const storedSigner = new PublicKey(current.signer);
		const signerEntry = transaction.signatures.find((entry) =>
			entry.publicKey.equals(storedSigner),
		);
		if (
			!signerEntry?.signature ||
			bs58.encode(signerEntry.signature) !== current.signature ||
			!transaction.verifySignatures(false) ||
			!transaction.recentBlockhash
		) {
			throw new Error("MagicBlock legacy evidence verification failed");
		}
		const riskAcknowledgement = requireExactRiskAcknowledgement(
			input.riskAcknowledgement,
		);
		const state: MagicBlockSmokeLegacyPendingState = {
			...current,
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			evidenceImport: {
				schemaVersion: "compass.magicblock-legacy-evidence/v1",
				authorizationId: requireId(input.authorizationId),
				operator: requireSafeText(input.operator),
				reason: requireSafeText(input.reason),
				authorizedAt: requireTimestamp(input.authorizedAt),
				riskAcknowledgement,
				transactionDigest: createHash("sha256")
					.update(serialized)
					.digest("hex"),
				recentBlockhash: requireBlockhash(transaction.recentBlockhash),
				importedAt: requireTimestamp(input.importedAt),
			},
		};
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function quarantineLegacyPendingMagicBlockSmoke(input: {
	readonly stateDirectory: string;
	readonly authorizationId: string;
	readonly incidentReference: string;
	readonly operator: string;
	readonly reason: string;
	readonly authorizedAt: string;
	readonly quarantinedAt: string;
	readonly acknowledgement: string;
	readonly endpointObservations?: {
		readonly solana: MagicBlockSmokeQuarantineEndpointObservation;
		readonly magicRouter: MagicBlockSmokeQuarantineEndpointObservation;
	};
	readonly observationUnavailableReason?: {
		readonly code: "READ_ONLY_RECONCILIATION_UNAVAILABLE";
		readonly observedAt: string;
	};
}): MagicBlockSmokeQuarantinedState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current?.status === "quarantined") {
			const expectedAdministration = createQuarantineAdministration(input);
			if (
				JSON.stringify(current.administration) !==
				JSON.stringify(expectedAdministration)
			) {
				throw new Error("MagicBlock legacy quarantine conflicts");
			}
			return current;
		}
		if (
			current?.status !== "legacy_pending" ||
			current.sourceSchemaVersion !== MAGICBLOCK_SMOKE_STATE_SCHEMA_V1 ||
			current.originalEvidence !== undefined ||
			current.evidenceImport !== undefined
		) {
			throw new Error("MagicBlock legacy quarantine unavailable");
		}
		const administration = createQuarantineAdministration(input);
		if (
			administration.endpointObservations &&
			(administration.endpointObservations.solana.signature !==
				current.signature ||
				administration.endpointObservations.magicRouter.signature !==
					current.signature)
		) {
			throw new Error("MagicBlock legacy quarantine observation conflicts");
		}
		const state: MagicBlockSmokeQuarantinedState = Object.freeze({
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "quarantined",
			historicalOutcome: "unknown",
			terminalizationImpossibleReason:
				MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON,
			scope: Object.freeze({
				cluster: "devnet",
				lane: "magicblock_devnet_audit_memo",
				valueTransferLamports: 0,
				noPaymentExecution: true,
				oldSignatureRetryProhibited: true,
				genericExecutionFenceReleased: false,
			}),
			legacyEvidence: current,
			administration,
		});
		writeStateAtomically(input.stateDirectory, state);
		return state;
	});
}

function createQuarantineAdministration(input: {
	readonly authorizationId: string;
	readonly incidentReference: string;
	readonly operator: string;
	readonly reason: string;
	readonly authorizedAt: string;
	readonly quarantinedAt: string;
	readonly acknowledgement: string;
	readonly endpointObservations?: {
		readonly solana: MagicBlockSmokeQuarantineEndpointObservation;
		readonly magicRouter: MagicBlockSmokeQuarantineEndpointObservation;
	};
	readonly observationUnavailableReason?: {
		readonly code: "READ_ONLY_RECONCILIATION_UNAVAILABLE";
		readonly observedAt: string;
	};
}): MagicBlockSmokeQuarantinedState["administration"] {
	if (
		Boolean(input.endpointObservations) ===
		Boolean(input.observationUnavailableReason)
	) {
		throw new Error("MagicBlock legacy quarantine observation unavailable");
	}
	if (input.acknowledgement !== MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT) {
		throw new Error("MagicBlock legacy quarantine acknowledgement unavailable");
	}
	if (
		input.endpointObservations &&
		((input.endpointObservations.solana.status === "confirmed" &&
			input.endpointObservations.magicRouter.status === "confirmed") ||
			(input.endpointObservations.solana.status === "execution_failed" &&
				input.endpointObservations.magicRouter.status === "execution_failed"))
	) {
		throw new Error("MagicBlock legacy quarantine has terminal evidence");
	}
	return Object.freeze({
		schemaVersion: "compass.magicblock-legacy-quarantine/v1",
		authorizationId: requireId(input.authorizationId),
		incidentReference: requireId(input.incidentReference),
		operator: requireSafeText(input.operator),
		reason: requireSafeText(input.reason),
		authorizedAt: requireTimestamp(input.authorizedAt),
		quarantinedAt: requireTimestamp(input.quarantinedAt),
		acknowledgement: MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT,
		verifiedSerializedTransactionAvailable: false,
		...(input.endpointObservations
			? {
					endpointObservations: Object.freeze({
						solana: validateQuarantineEndpointObservation(
							input.endpointObservations.solana,
							"solana_devnet",
						),
						magicRouter: validateQuarantineEndpointObservation(
							input.endpointObservations.magicRouter,
							"magic_router",
						),
					}),
				}
			: {
					observationUnavailableReason: Object.freeze({
						code: "READ_ONLY_RECONCILIATION_UNAVAILABLE" as const,
						observedAt: requireTimestamp(
							input.observationUnavailableReason?.observedAt,
						),
					}),
				}),
	});
}

export function reconcileMagicBlockSmoke(input: {
	readonly stateDirectory: string;
	readonly outcome: MagicBlockSmokeReconciledState["outcome"];
	readonly signature?: string;
	readonly reconciledAt: string;
	readonly expiryEvidence?: {
		readonly solana: MagicBlockSmokeEndpointExpiryEvidence;
		readonly magicRouter: MagicBlockSmokeEndpointExpiryEvidence;
	};
}): MagicBlockSmokeReconciledState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current?.status === "reconciled") {
			if (
				current.outcome !== input.outcome ||
				current.signature !== input.signature
			) {
				throw new Error("MagicBlock smoke reconciliation conflicts");
			}
			return current;
		}
		const reconciledAt = requireTimestamp(input.reconciledAt);
		let state: MagicBlockSmokeReconciledState;
		if (current?.status === "active" && input.outcome === "not_submitted") {
			if (input.signature !== undefined) {
				throw new Error("MagicBlock active smoke has no prepared signature");
			}
			state = {
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "reconciled",
				outcome: "not_submitted",
				reconciledAt,
			};
		} else if (
			(current?.status === "pending" ||
				current?.status === "legacy_pending") &&
			(input.outcome === "confirmed" ||
				input.outcome === "failed" ||
				input.outcome === "expired_not_landed") &&
			(input.outcome !== "expired_not_landed" ||
				provesExpiredForState(current, input.expiryEvidence)) &&
			current.signature === requireSignature(input.signature)
		) {
			state = {
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "reconciled",
				outcome: input.outcome,
				signature: current.signature,
				reconciledAt,
				preparedEvidence: current,
				...(input.outcome === "expired_not_landed"
					? { expiryEvidence: input.expiryEvidence }
					: {}),
			};
		} else {
			throw new Error("MagicBlock smoke reconciliation is ambiguous");
		}
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

function provesExpiredForState(
	state: MagicBlockSmokePendingState | MagicBlockSmokeLegacyPendingState,
	evidence:
		| {
				readonly solana: MagicBlockSmokeEndpointExpiryEvidence;
				readonly magicRouter: MagicBlockSmokeEndpointExpiryEvidence;
		  }
		| undefined,
): boolean {
	if (!evidence) return false;
	const recentBlockhash =
		state.status === "pending"
			? state.recentBlockhash
			: state.evidenceImport?.recentBlockhash ??
				state.originalEvidence?.recentBlockhash;
	if (!recentBlockhash) return false;
	const lastValidBlockHeight =
		state.status === "pending"
			? state.lastValidBlockHeight
			: state.originalEvidence?.lastValidBlockHeight;
	return (
		evidence.solana.endpoint === "solana_devnet" &&
		state.signature === evidence.solana.signature &&
		recentBlockhash === evidence.solana.recentBlockhash &&
		endpointProvesExpiredAndNotLanded(
			evidence.solana,
			lastValidBlockHeight,
		) &&
		evidence.magicRouter.endpoint === "magic_router" &&
		state.signature === evidence.magicRouter.signature &&
		recentBlockhash === evidence.magicRouter.recentBlockhash &&
		endpointProvesExpiredAndNotLanded(
			evidence.magicRouter,
			lastValidBlockHeight,
		)
	);
}

export function readMagicBlockSmokeState(
	stateDirectory: string,
): MagicBlockSmokeState | null {
	requireStateDirectory(stateDirectory);
	return readMagicBlockSmokeStateUnlocked(stateDirectory);
}

export function classifyMagicBlockSmokeReconciliation(
	solana: MagicBlockOnchainAuditRegistration,
	magicRouter: MagicBlockOnchainAuditRegistration,
	expiry?: {
		readonly solana: MagicBlockSmokeEndpointExpiryEvidence;
		readonly magicRouter: MagicBlockSmokeEndpointExpiryEvidence;
		readonly lastValidBlockHeight?: number;
	},
): "confirmed" | "failed" | "expired_not_landed" | null {
	if (
		solana.status === "confirmed" &&
		magicRouter.status === "confirmed" &&
		solana.signature === magicRouter.signature
	) {
		return "confirmed";
	}
	if (
		solana.status === "retryable_failure" &&
		magicRouter.status === "retryable_failure" &&
		solana.code === "TRANSACTION_EXECUTION_FAILED" &&
		magicRouter.code === "TRANSACTION_EXECUTION_FAILED" &&
		solana.signature !== undefined &&
		solana.signature === magicRouter.signature
	) {
		return "failed";
	}
	if (
		expiry &&
		solana.status === "retryable_failure" &&
		magicRouter.status === "retryable_failure" &&
		solana.code === "SUBMISSION_UNCONFIRMED" &&
		magicRouter.code === "SUBMISSION_UNCONFIRMED" &&
		solana.signature !== undefined &&
		solana.signature === magicRouter.signature &&
		expiry.solana.endpoint === "solana_devnet" &&
		expiry.magicRouter.endpoint === "magic_router" &&
		expiry.solana.signature === solana.signature &&
		expiry.magicRouter.signature === solana.signature &&
		expiry.solana.recentBlockhash ===
			expiry.magicRouter.recentBlockhash &&
		endpointProvesExpiredAndNotLanded(
			expiry.solana,
			expiry.lastValidBlockHeight,
		) &&
		endpointProvesExpiredAndNotLanded(
			expiry.magicRouter,
			expiry.lastValidBlockHeight,
		)
	) {
		return "expired_not_landed";
	}
	return null;
}

export async function collectMagicBlockSmokeEndpointExpiryEvidence(
	rpc: MagicBlockRouterRpc,
	endpoint: MagicBlockSmokeEndpointExpiryEvidence["endpoint"],
	signature: string,
	recentBlockhash: string,
	now: () => string = () => new Date().toISOString(),
): Promise<MagicBlockSmokeEndpointExpiryEvidence> {
	const checkedEndpoint = requireEndpoint(endpoint);
	const checkedSignature = requireSignature(signature);
	const checkedBlockhash = requireBlockhash(recentBlockhash);
	let signatureStatus: MagicBlockSmokeEndpointExpiryEvidence["signatureStatus"] =
		"ambiguous";
	let blockhashValidity: MagicBlockSmokeEndpointExpiryEvidence["blockhashValidity"] =
		"ambiguous";
	let expiryContextSlot: number | undefined;
	let signatureContextSlot: number | undefined;
	let blockHeight: number | undefined;
	try {
		const blockhashResponse = asRecord(
			await rpc("isBlockhashValid", [
				checkedBlockhash,
				{ commitment: "finalized" },
			]),
		);
		const blockhashContext = asRecord(blockhashResponse.context);
		if (Number.isSafeInteger(blockhashContext.slot)) {
			expiryContextSlot = Number(blockhashContext.slot);
		}
		if (typeof blockhashResponse.value === "boolean") {
			blockhashValidity = blockhashResponse.value ? "valid" : "invalid";
		}
		try {
			const height = await rpc("getBlockHeight", [
				{ commitment: "finalized" },
			]);
			if (Number.isSafeInteger(height) && Number(height) >= 0) {
				blockHeight = Number(height);
			}
		} catch {
			// Optional corroboration only; absence cannot weaken blockhash-invalid proof.
		}
		const statusResponse = asRecord(
			await rpc("getSignatureStatuses", [
				[checkedSignature],
				{ searchTransactionHistory: true },
			]),
		);
		const statusContext = asRecord(statusResponse.context);
		if (Number.isSafeInteger(statusContext.slot)) {
			signatureContextSlot = Number(statusContext.slot);
		}
		if (
			Array.isArray(statusResponse.value) &&
			statusResponse.value.length === 1 &&
			expiryContextSlot !== undefined &&
			signatureContextSlot !== undefined &&
			signatureContextSlot >= expiryContextSlot
		) {
			signatureStatus =
				statusResponse.value[0] === null ? "not_found" : "present";
		}
	} catch {
		// Malformed or unavailable endpoint evidence remains explicitly ambiguous.
	}
	return Object.freeze({
		endpoint: checkedEndpoint,
		signature: checkedSignature,
		recentBlockhash: checkedBlockhash,
		commitment: "finalized",
		signatureStatus,
		blockhashValidity,
		...(expiryContextSlot !== undefined ? { expiryContextSlot } : {}),
		...(signatureContextSlot !== undefined ? { signatureContextSlot } : {}),
		...(blockHeight !== undefined ? { blockHeight } : {}),
		observedAt: requireTimestamp(now()),
	});
}

function endpointProvesExpiredAndNotLanded(
	evidence: MagicBlockSmokeEndpointExpiryEvidence,
	lastValidBlockHeight?: number,
): boolean {
	return (
		evidence.signatureStatus === "not_found" &&
		evidence.blockhashValidity === "invalid" &&
		evidence.commitment === "finalized" &&
		evidence.expiryContextSlot !== undefined &&
		evidence.signatureContextSlot !== undefined &&
		evidence.signatureContextSlot >= evidence.expiryContextSlot &&
		(lastValidBlockHeight === undefined ||
			evidence.blockHeight === undefined ||
			evidence.blockHeight > lastValidBlockHeight)
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function withStateLock<T>(
	stateDirectory: string,
	operation: () => T,
): T {
	requireStateDirectory(stateDirectory);
	mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	const lockPath = join(stateDirectory, LOCK_FILE);
	let lock: number | undefined;
	try {
		lock = openSync(lockPath, "wx", 0o600);
		writeFileSync(lock, `${process.pid}\n`, "utf8");
		fsyncSync(lock);
	} catch {
		if (lock !== undefined) {
			closeSync(lock);
			if (existsSync(lockPath)) unlinkSync(lockPath);
		}
		throw new Error("MagicBlock smoke state is locked");
	}
	if (lock === undefined) throw new Error("MagicBlock smoke state is locked");
	try {
		return operation();
	} finally {
		closeSync(lock);
		unlinkSync(lockPath);
	}
}

function readMagicBlockSmokeStateUnlocked(
	stateDirectory: string,
): MagicBlockSmokeState | null {
	const path = join(stateDirectory, STATE_FILE);
	if (!existsSync(path)) return null;
	const stats = statSync(path);
	if (!stats.isFile() || stats.size < 2 || stats.size > MAX_STATE_BYTES) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return validateState(value);
}

function writeStateAtomically(
	stateDirectory: string,
	state: MagicBlockSmokeState,
): void {
	const temporaryPath = join(stateDirectory, `.state-${randomUUID()}.tmp`);
	const destinationPath = join(stateDirectory, STATE_FILE);
	let file: number | undefined;
	try {
		file = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(temporaryPath, destinationPath);
		fsyncDirectory(stateDirectory);
	} catch {
		if (file !== undefined) closeSync(file);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw new Error("MagicBlock smoke state persistence unavailable");
	}
}

function archiveInactiveState(
	stateDirectory: string,
	state: MagicBlockSmokeReconciledState | MagicBlockSmokeQuarantinedState,
): void {
	const historyDirectory = join(stateDirectory, "history");
	mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
	const archivePath = join(
		historyDirectory,
		`${(state.status === "reconciled"
			? state.reconciledAt
			: state.administration.quarantinedAt
		).replace(/[^0-9]/g, "")}-${randomUUID()}.json`,
	);
	renameSync(join(stateDirectory, STATE_FILE), archivePath);
	fsyncDirectory(historyDirectory);
	fsyncDirectory(stateDirectory);
}

function fsyncDirectory(path: string): void {
	let directory: number | undefined;
	try {
		directory = openSync(path, "r");
		fsyncSync(directory);
	} finally {
		if (directory !== undefined) closeSync(directory);
	}
}

function validateState(value: unknown): MagicBlockSmokeState {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion === MAGICBLOCK_SMOKE_STATE_SCHEMA_V1) {
		return validateLegacyState(record, MAGICBLOCK_SMOKE_STATE_SCHEMA_V1);
	}
	if (record.schemaVersion === MAGICBLOCK_SMOKE_STATE_SCHEMA_V2) {
		return validateLegacyState(record, MAGICBLOCK_SMOKE_STATE_SCHEMA_V2);
	}
	if (record.schemaVersion !== MAGICBLOCK_SMOKE_STATE_SCHEMA) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	switch (record.status) {
		case "authorized":
			requireExactKeys(record, [
				"authorizationNonce",
				"createdAt",
				"schemaVersion",
				"status",
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "authorized",
				authorizationNonce: requireNonce(record.authorizationNonce),
				createdAt: requireTimestamp(record.createdAt),
			});
		case "active":
			requireExactKeys(record, [
				"auditEventId",
				"authorizationNonce",
				"observationId",
				"schemaVersion",
				"startedAt",
				"status",
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "active",
				authorizationNonce: requireNonce(record.authorizationNonce),
				auditEventId: requireId(record.auditEventId),
				observationId: requireId(record.observationId),
				startedAt: requireTimestamp(record.startedAt),
			});
		case "pending": {
			requireExactKeys(record, [
				"auditEventId",
				"authorizationNonce",
				"blockhashValidityEvidence",
				"cluster",
				"commitmentDigest",
				"lane",
				"memo",
				"observationId",
				"preparedAt",
				"recentBlockhash",
				"lastValidBlockHeight",
				"schemaVersion",
				"serializedTransactionBase64",
				"serializedTransactionDigest",
				"signer",
				"signature",
				"status",
				"valueTransferLamports",
			]);
			if (
				record.cluster !== "devnet" ||
				record.lane !== "magicblock_devnet_audit_memo" ||
				record.valueTransferLamports !== 0
			) {
				throw new Error("MagicBlock smoke state unavailable");
			}
			const pending = Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "pending",
				cluster: "devnet" as const,
				lane: "magicblock_devnet_audit_memo" as const,
				valueTransferLamports: 0 as const,
				authorizationNonce: requireNonce(record.authorizationNonce),
				auditEventId: requireId(record.auditEventId),
				observationId: requireId(record.observationId),
				signer: requireSigner(record.signer),
				signature: requireSignature(record.signature),
				commitmentDigest: requireDigest(record.commitmentDigest),
				memo: requireMemo(record.memo),
				recentBlockhash: requireBlockhash(record.recentBlockhash),
				lastValidBlockHeight: requireBlockHeight(record.lastValidBlockHeight),
				serializedTransactionBase64: requireSerializedTransactionBase64(
					record.serializedTransactionBase64,
				),
				serializedTransactionDigest: requireDigest(
					record.serializedTransactionDigest,
				),
				blockhashValidityEvidence: validateBlockhashValidityEvidence(
					record.blockhashValidityEvidence,
					requireBlockhash(record.recentBlockhash),
				),
				preparedAt: requireTimestamp(record.preparedAt),
			});
			validatePreparedTransactionBinding(pending);
			return pending;
		}
		case "legacy_pending": {
			const originalEvidence = validateOriginalEvidence(record.originalEvidence);
			const evidenceImport = validateEvidenceImport(record.evidenceImport);
			requireExactKeys(record, [
				"importedAt",
				"schemaVersion",
				"signer",
				"signature",
				"sourceSchemaVersion",
				"status",
				...(originalEvidence ? ["originalEvidence"] : []),
				...(evidenceImport ? ["evidenceImport"] : []),
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "legacy_pending",
				signer: requireSigner(record.signer),
				signature: requireSignature(record.signature),
				importedAt: requireTimestamp(record.importedAt),
				sourceSchemaVersion: requireV1Schema(record.sourceSchemaVersion),
				...(originalEvidence ? { originalEvidence } : {}),
				...(evidenceImport ? { evidenceImport } : {}),
			});
		}
		case "reconciled": {
			const hasSignature = record.signature !== undefined;
			const preparedEvidence =
				record.preparedEvidence !== undefined
					? validatePreparedEvidence(record.preparedEvidence)
					: undefined;
			const expiryEvidence =
				record.expiryEvidence !== undefined
					? validateExpiryEvidence(record.expiryEvidence)
					: undefined;
			requireExactKeys(
				record,
				hasSignature
					? [
							"outcome",
							"reconciledAt",
							"schemaVersion",
							"signature",
							"status",
							...(preparedEvidence ? ["preparedEvidence"] : []),
							...(expiryEvidence ? ["expiryEvidence"] : []),
						]
					: ["outcome", "reconciledAt", "schemaVersion", "status"],
			);
			if (
				![
					"confirmed",
					"failed",
					"expired_not_landed",
					"not_submitted",
				].includes(
					String(record.outcome),
				) ||
					(record.outcome === "not_submitted") !== !hasSignature
					|| (record.outcome === "expired_not_landed") !==
						Boolean(expiryEvidence)
					|| (!hasSignature && preparedEvidence !== undefined)
					|| (record.outcome === "expired_not_landed" &&
						(!preparedEvidence ||
							!provesExpiredForState(
								preparedEvidence,
								expiryEvidence,
							)))
			) {
				throw new Error("MagicBlock smoke state unavailable");
			}
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "reconciled",
				outcome: record.outcome as MagicBlockSmokeReconciledState["outcome"],
				...(hasSignature
					? { signature: requireSignature(record.signature) }
					: {}),
				reconciledAt: requireTimestamp(record.reconciledAt),
				...(preparedEvidence ? { preparedEvidence } : {}),
				...(expiryEvidence ? { expiryEvidence } : {}),
			});
		}
		case "quarantined":
			return validateQuarantinedState(record);
		default:
			throw new Error("MagicBlock smoke state unavailable");
	}
}

function validatePreparedEvidence(
	value: unknown,
): MagicBlockSmokePendingState | MagicBlockSmokeLegacyPendingState {
	const state = validateState(value);
	if (state.status !== "pending" && state.status !== "legacy_pending") {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return state;
}

function validateExpiryEvidence(
	value: unknown,
): {
	readonly solana: MagicBlockSmokeEndpointExpiryEvidence;
	readonly magicRouter: MagicBlockSmokeEndpointExpiryEvidence;
} {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	requireExactKeys(record, ["magicRouter", "solana"]);
	return Object.freeze({
		solana: validateEndpointEvidence(record.solana),
		magicRouter: validateEndpointEvidence(record.magicRouter),
	});
}

function validateEndpointEvidence(
	value: unknown,
): MagicBlockSmokeEndpointExpiryEvidence {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	const hasHeight = record.blockHeight !== undefined;
	const hasExpiryContext = record.expiryContextSlot !== undefined;
	const hasSignatureContext = record.signatureContextSlot !== undefined;
	requireExactKeys(record, [
		"blockhashValidity",
		"commitment",
		"endpoint",
		"observedAt",
		"recentBlockhash",
		"signature",
		"signatureStatus",
		...(hasHeight ? ["blockHeight"] : []),
		...(hasExpiryContext ? ["expiryContextSlot"] : []),
		...(hasSignatureContext ? ["signatureContextSlot"] : []),
	]);
	if (
		!["solana_devnet", "magic_router"].includes(String(record.endpoint)) ||
		record.commitment !== "finalized" ||
		!["not_found", "present", "ambiguous"].includes(
			String(record.signatureStatus),
		) ||
		!["invalid", "valid", "ambiguous"].includes(
			String(record.blockhashValidity),
		)
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return Object.freeze({
		endpoint: requireEndpoint(record.endpoint),
		signature: requireSignature(record.signature),
		recentBlockhash: requireBlockhash(record.recentBlockhash),
		commitment: "finalized",
		signatureStatus:
			record.signatureStatus as MagicBlockSmokeEndpointExpiryEvidence["signatureStatus"],
		blockhashValidity:
			record.blockhashValidity as MagicBlockSmokeEndpointExpiryEvidence["blockhashValidity"],
		...(hasExpiryContext
			? { expiryContextSlot: requireBlockHeight(record.expiryContextSlot) }
			: {}),
		...(hasSignatureContext
			? {
					signatureContextSlot: requireBlockHeight(
						record.signatureContextSlot,
					),
				}
			: {}),
		...(hasHeight ? { blockHeight: requireBlockHeight(record.blockHeight) } : {}),
		observedAt: requireTimestamp(record.observedAt),
	});
}

function validateLegacyState(
	record: Record<string, unknown>,
	sourceSchemaVersion:
		| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V1
		| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V2,
): MagicBlockSmokeState {
	switch (record.status) {
		case "authorized":
		case "active":
		case "reconciled":
			return validateState({ ...record, schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA });
		case "pending":
			requireExactKeys(record, [
				"auditEventId",
				"authorizationNonce",
				"commitmentDigest",
				"memo",
				"observationId",
				"preparedAt",
				...(sourceSchemaVersion === MAGICBLOCK_SMOKE_STATE_SCHEMA_V2
					? ["recentBlockhash", "lastValidBlockHeight"]
					: []),
				"schemaVersion",
				"signer",
				"signature",
				"status",
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "legacy_pending",
				signer: requireSigner(record.signer),
				signature: requireSignature(record.signature),
				importedAt: requireTimestamp(record.preparedAt),
				sourceSchemaVersion,
				originalEvidence: Object.freeze({
					authorizationNonce: requireNonce(record.authorizationNonce),
					auditEventId: requireId(record.auditEventId),
					observationId: requireId(record.observationId),
					commitmentDigest: requireDigest(record.commitmentDigest),
					memo: requireMemo(record.memo),
					preparedAt: requireTimestamp(record.preparedAt),
					...(sourceSchemaVersion === MAGICBLOCK_SMOKE_STATE_SCHEMA_V2
						? {
								recentBlockhash: requireBlockhash(record.recentBlockhash),
								lastValidBlockHeight: requireBlockHeight(
									record.lastValidBlockHeight,
								),
							}
						: {}),
				}),
			});
		case "legacy_pending":
			if (sourceSchemaVersion === MAGICBLOCK_SMOKE_STATE_SCHEMA_V2) {
				return validateState({
					...record,
					schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				});
			}
			requireExactKeys(record, [
				"importedAt",
				"schemaVersion",
				"signer",
				"signature",
				"status",
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "legacy_pending",
				signer: requireSigner(record.signer),
				signature: requireSignature(record.signature),
				importedAt: requireTimestamp(record.importedAt),
				sourceSchemaVersion,
			});
		default:
			throw new Error("MagicBlock smoke state unavailable");
	}
}

function validateOriginalEvidence(
	value: unknown,
): MagicBlockSmokeLegacyPendingState["originalEvidence"] | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	const allowed = [
		"authorizationNonce",
		"auditEventId",
		"observationId",
		"commitmentDigest",
		"memo",
		"preparedAt",
		"recentBlockhash",
		"lastValidBlockHeight",
	];
	if (Object.keys(record).some((key) => !allowed.includes(key))) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return Object.freeze({
		...(record.authorizationNonce !== undefined
			? { authorizationNonce: requireNonce(record.authorizationNonce) }
			: {}),
		...(record.auditEventId !== undefined
			? { auditEventId: requireId(record.auditEventId) }
			: {}),
		...(record.observationId !== undefined
			? { observationId: requireId(record.observationId) }
			: {}),
		...(record.commitmentDigest !== undefined
			? { commitmentDigest: requireDigest(record.commitmentDigest) }
			: {}),
		...(record.memo !== undefined ? { memo: requireMemo(record.memo) } : {}),
		...(record.preparedAt !== undefined
			? { preparedAt: requireTimestamp(record.preparedAt) }
			: {}),
		...(record.recentBlockhash !== undefined
			? { recentBlockhash: requireBlockhash(record.recentBlockhash) }
			: {}),
		...(record.lastValidBlockHeight !== undefined
			? {
					lastValidBlockHeight: requireBlockHeight(
						record.lastValidBlockHeight,
					),
				}
			: {}),
	});
}

function validateEvidenceImport(
	value: unknown,
): MagicBlockSmokeLegacyPendingState["evidenceImport"] | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	requireExactKeys(record, [
		"authorizationId",
		"authorizedAt",
		"importedAt",
		"operator",
		"reason",
		"recentBlockhash",
		"riskAcknowledgement",
		"schemaVersion",
		"transactionDigest",
	]);
	if (record.schemaVersion !== "compass.magicblock-legacy-evidence/v1") {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return Object.freeze({
		schemaVersion: "compass.magicblock-legacy-evidence/v1",
		authorizationId: requireId(record.authorizationId),
		operator: requireSafeText(record.operator),
		reason: requireSafeText(record.reason),
		authorizedAt: requireTimestamp(record.authorizedAt),
		riskAcknowledgement: requireExactRiskAcknowledgement(
			record.riskAcknowledgement,
		),
		transactionDigest: requireDigest(record.transactionDigest),
		recentBlockhash: requireBlockhash(record.recentBlockhash),
		importedAt: requireTimestamp(record.importedAt),
	});
}

function validateBlockhashValidityEvidence(
	value: unknown,
	recentBlockhash: string,
): MagicBlockSmokePendingState["blockhashValidityEvidence"] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	requireExactKeys(record, ["magicRouter", "solana"]);
	return Object.freeze({
		solana: validateBlockhashValidityObservation(
			record.solana,
			"solana_devnet",
			recentBlockhash,
		),
		magicRouter: validateBlockhashValidityObservation(
			record.magicRouter,
			"magic_router",
			recentBlockhash,
		),
	});
}

function validateBlockhashValidityObservation(
	value: unknown,
	expectedEndpoint: "solana_devnet" | "magic_router",
	recentBlockhash: string,
): MagicBlockSmokePendingState["blockhashValidityEvidence"]["solana"] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const record = value as Record<string, unknown>;
	requireExactKeys(record, [
		"commitment",
		"contextSlot",
		"endpoint",
		"observedAt",
		"recentBlockhash",
		"validity",
	]);
	if (
		record.endpoint !== expectedEndpoint ||
		record.commitment !== "confirmed" ||
		record.validity !== "valid" ||
		requireBlockhash(record.recentBlockhash) !== recentBlockhash
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return Object.freeze({
		endpoint: expectedEndpoint,
		recentBlockhash,
		commitment: "confirmed",
		contextSlot: requireBlockHeight(record.contextSlot),
		validity: "valid",
		observedAt: requireTimestamp(record.observedAt),
	});
}

function validatePreparedTransactionBinding(
	state: MagicBlockSmokePendingState,
): void {
	let serialized: Buffer;
	let transaction: Transaction;
	try {
		serialized = Buffer.from(state.serializedTransactionBase64, "base64");
		if (
			serialized.length < 1 ||
			serialized.toString("base64") !== state.serializedTransactionBase64 ||
			createHash("sha256").update(serialized).digest("hex") !==
				state.serializedTransactionDigest
		) {
			throw new Error("invalid");
		}
		transaction = Transaction.from(serialized);
	} catch {
		throw new Error("MagicBlock prepared transaction verification failed");
	}
	const storedSigner = new PublicKey(state.signer);
	const signerEntry = transaction.signatures.find((entry) =>
		entry.publicKey.equals(storedSigner),
	);
	const instruction = transaction.instructions[0];
	if (
		transaction.signatures.length !== 1 ||
		!signerEntry?.signature ||
		bs58.encode(signerEntry.signature) !== state.signature ||
		!transaction.verifySignatures(false) ||
		transaction.feePayer?.toBase58() !== state.signer ||
		transaction.recentBlockhash !== state.recentBlockhash ||
		transaction.instructions.length !== 1 ||
		instruction?.programId.toBase58() !==
			"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" ||
		instruction.keys.length !== 1 ||
		instruction.keys[0]?.pubkey.toBase58() !== state.signer ||
		instruction.keys[0]?.isSigner !== true ||
		instruction.data.toString("utf8") !== state.memo
	) {
		throw new Error("MagicBlock prepared transaction verification failed");
	}
}

function requireSerializedTransactionBase64(value: unknown): string {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") < 1 ||
		Buffer.byteLength(value, "utf8") > MAX_EVIDENCE_BYTES
	) {
		throw new Error("MagicBlock prepared transaction unavailable");
	}
	return value;
}

function validateQuarantineEndpointObservation(
	value: unknown,
	expectedEndpoint: "solana_devnet" | "magic_router",
): MagicBlockSmokeQuarantineEndpointObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MagicBlock legacy quarantine observation unavailable");
	}
	const record = value as Record<string, unknown>;
	requireExactKeys(record, ["endpoint", "observedAt", "signature", "status"]);
	if (
		record.endpoint !== expectedEndpoint ||
		!["confirmed", "execution_failed", "not_found", "ambiguous", "unavailable"].includes(
			String(record.status),
		)
	) {
		throw new Error("MagicBlock legacy quarantine observation unavailable");
	}
	return Object.freeze({
		endpoint: expectedEndpoint,
		signature: requireSignature(record.signature),
		status:
			record.status as MagicBlockSmokeQuarantineEndpointObservation["status"],
		observedAt: requireTimestamp(record.observedAt),
	});
}

function validateQuarantinedState(
	record: Record<string, unknown>,
): MagicBlockSmokeQuarantinedState {
	requireExactKeys(record, [
		"administration",
		"historicalOutcome",
		"legacyEvidence",
		"schemaVersion",
		"scope",
		"status",
		"terminalizationImpossibleReason",
	]);
	if (
		record.historicalOutcome !== "unknown" ||
		record.terminalizationImpossibleReason !==
			MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const scope = asRecord(record.scope);
	requireExactKeys(scope, [
		"cluster",
		"genericExecutionFenceReleased",
		"lane",
		"noPaymentExecution",
		"oldSignatureRetryProhibited",
		"valueTransferLamports",
	]);
	if (
		scope.cluster !== "devnet" ||
		scope.lane !== "magicblock_devnet_audit_memo" ||
		scope.valueTransferLamports !== 0 ||
		scope.noPaymentExecution !== true ||
		scope.oldSignatureRetryProhibited !== true ||
		scope.genericExecutionFenceReleased !== false
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const legacyEvidence = validateState(record.legacyEvidence);
	if (
		legacyEvidence.status !== "legacy_pending" ||
		legacyEvidence.sourceSchemaVersion !== MAGICBLOCK_SMOKE_STATE_SCHEMA_V1 ||
		legacyEvidence.originalEvidence !== undefined ||
		legacyEvidence.evidenceImport !== undefined
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	const administrationRecord = asRecord(record.administration);
	const hasObservations = administrationRecord.endpointObservations !== undefined;
	const hasUnavailableReason =
		administrationRecord.observationUnavailableReason !== undefined;
	requireExactKeys(administrationRecord, [
		"acknowledgement",
		"authorizationId",
		"authorizedAt",
		"incidentReference",
		"operator",
		"quarantinedAt",
		"reason",
		"schemaVersion",
		"verifiedSerializedTransactionAvailable",
		...(hasObservations ? ["endpointObservations"] : []),
		...(hasUnavailableReason ? ["observationUnavailableReason"] : []),
	]);
	if (
		administrationRecord.schemaVersion !==
			"compass.magicblock-legacy-quarantine/v1" ||
		administrationRecord.verifiedSerializedTransactionAvailable !== false
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	let endpointObservations:
		| MagicBlockSmokeQuarantinedState["administration"]["endpointObservations"]
		| undefined;
	if (hasObservations) {
		const observations = asRecord(administrationRecord.endpointObservations);
		requireExactKeys(observations, ["magicRouter", "solana"]);
		endpointObservations = Object.freeze({
			solana: validateQuarantineEndpointObservation(
				observations.solana,
				"solana_devnet",
			),
			magicRouter: validateQuarantineEndpointObservation(
				observations.magicRouter,
				"magic_router",
			),
		});
	}
	let observationUnavailableReason:
		| MagicBlockSmokeQuarantinedState["administration"]["observationUnavailableReason"]
		| undefined;
	if (hasUnavailableReason) {
		const unavailable = asRecord(
			administrationRecord.observationUnavailableReason,
		);
		requireExactKeys(unavailable, ["code", "observedAt"]);
		if (unavailable.code !== "READ_ONLY_RECONCILIATION_UNAVAILABLE") {
			throw new Error("MagicBlock smoke state unavailable");
		}
		observationUnavailableReason = Object.freeze({
			code: "READ_ONLY_RECONCILIATION_UNAVAILABLE",
			observedAt: requireTimestamp(unavailable.observedAt),
		});
	}
	const administration = createQuarantineAdministration({
		authorizationId: requireId(administrationRecord.authorizationId),
		incidentReference: requireId(administrationRecord.incidentReference),
		operator: requireSafeText(administrationRecord.operator),
		reason: requireSafeText(administrationRecord.reason),
		authorizedAt: requireTimestamp(administrationRecord.authorizedAt),
		quarantinedAt: requireTimestamp(administrationRecord.quarantinedAt),
		acknowledgement: String(administrationRecord.acknowledgement),
		...(endpointObservations ? { endpointObservations } : {}),
		...(observationUnavailableReason ? { observationUnavailableReason } : {}),
	});
	if (
		administration.endpointObservations &&
		(administration.endpointObservations.solana.signature !==
			legacyEvidence.signature ||
			administration.endpointObservations.magicRouter.signature !==
				legacyEvidence.signature)
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
	return Object.freeze({
		schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
		status: "quarantined",
		historicalOutcome: "unknown",
		terminalizationImpossibleReason:
			MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON,
		scope: Object.freeze({
			cluster: "devnet",
			lane: "magicblock_devnet_audit_memo",
			valueTransferLamports: 0,
			noPaymentExecution: true,
			oldSignatureRetryProhibited: true,
			genericExecutionFenceReleased: false,
		}),
		legacyEvidence,
		administration,
	});
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const keys = Object.keys(value).sort();
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== [...expected].sort()[index])
	) {
		throw new Error("MagicBlock smoke state unavailable");
	}
}

function requireStateDirectory(value: string): string {
	if (!isAbsolute(value)) throw new Error("MagicBlock smoke state directory unavailable");
	return value;
}

function requireEvidenceFile(value: string, stateDirectory: string): string {
	if (!isAbsolute(value)) {
		throw new Error("MagicBlock legacy evidence file unavailable");
	}
	const requestedEvidencePath = resolve(value);
	let evidencePath: string;
	let stateRoot: string;
	try {
		if (lstatSync(requestedEvidencePath).isSymbolicLink()) {
			throw new Error("symlink");
		}
		evidencePath = realpathSync(requestedEvidencePath);
		stateRoot = realpathSync(stateDirectory);
	} catch {
		throw new Error("MagicBlock legacy evidence file unavailable");
	}
	const relativePath = relative(stateRoot, evidencePath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	) {
		throw new Error("MagicBlock legacy evidence file unavailable");
	}
	return evidencePath;
}

function requireEndpoint(
	value: unknown,
): MagicBlockSmokeEndpointExpiryEvidence["endpoint"] {
	if (value !== "solana_devnet" && value !== "magic_router") {
		throw new Error("MagicBlock smoke endpoint unavailable");
	}
	return value;
}

function requireNonce(value: unknown): string {
	if (typeof value !== "string" || !SAFE_NONCE.test(value)) {
		throw new Error("MagicBlock smoke authorization unavailable");
	}
	return value;
}

function requireId(value: unknown): string {
	if (typeof value !== "string" || !SAFE_ID.test(value)) {
		throw new Error("MagicBlock smoke identifier unavailable");
	}
	return value;
}

function requireSafeText(value: unknown): string {
	if (
		typeof value !== "string" ||
		!SAFE_TEXT.test(value) ||
		/[<>{}\r\n]/.test(value)
	) {
		throw new Error("MagicBlock legacy evidence metadata unavailable");
	}
	return value;
}

function requireExactRiskAcknowledgement(
	value: unknown,
): typeof MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT {
	if (value !== MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT) {
		throw new Error("MagicBlock legacy evidence risk acknowledgement unavailable");
	}
	return value;
}

function requireV1Schema(
	value: unknown,
):
	| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V1
	| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V2 {
	if (
		value !== MAGICBLOCK_SMOKE_STATE_SCHEMA_V1 &&
		value !== MAGICBLOCK_SMOKE_STATE_SCHEMA_V2
	) {
		throw new Error("MagicBlock legacy source schema unavailable");
	}
	return value;
}

function requireTimestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error("MagicBlock smoke timestamp unavailable");
	}
	return value;
}

function requireSignature(value: unknown): string {
	if (typeof value !== "string" || !SIGNATURE.test(value)) {
		throw new Error("MagicBlock smoke signature unavailable");
	}
	return value;
}

function requireSigner(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("MagicBlock smoke signer unavailable");
	}
	try {
		if (new PublicKey(value).toBase58() !== value) {
			throw new Error("noncanonical");
		}
		return value;
	} catch {
		throw new Error("MagicBlock smoke signer unavailable");
	}
}

function requireDigest(value: unknown): string {
	if (typeof value !== "string" || !DIGEST.test(value)) {
		throw new Error("MagicBlock smoke commitment unavailable");
	}
	return value;
}

function requireBlockhash(value: unknown): string {
	if (typeof value !== "string" || !BLOCKHASH.test(value)) {
		throw new Error("MagicBlock smoke blockhash unavailable");
	}
	try {
		if (new PublicKey(value).toBase58() !== value) throw new Error("noncanonical");
		return value;
	} catch {
		throw new Error("MagicBlock smoke blockhash unavailable");
	}
}

function requireBlockHeight(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error("MagicBlock smoke block height unavailable");
	}
	return Number(value);
}

function requireMemo(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.startsWith("compass:audit:v1:") ||
		Buffer.byteLength(value, "utf8") > 400
	) {
		throw new Error("MagicBlock smoke Memo unavailable");
	}
	return value;
}
