import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { PublicKey } from "@solana/web3.js";

import type {
	MagicBlockOnchainAuditRegistration,
	MagicBlockRetryableAuditFailure,
} from "../back/services/magicBlockOnchainAuditContracts";
import {
	MAGICBLOCK_SMOKE_STATE_SCHEMA,
	type MagicBlockSmokeActiveState,
	type MagicBlockSmokeAuthorizedState,
	type MagicBlockSmokeLegacyPendingState,
	type MagicBlockSmokePendingState,
	type MagicBlockSmokeReconciledState,
	type MagicBlockSmokeState,
} from "./magicBlockDevnetSmokeStateContracts";

const STATE_FILE = "state.json";
const LOCK_FILE = "state.lock";
const MAX_STATE_BYTES = 2_048;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_NONCE = /^[A-Za-z0-9._:-]{16,128}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function createMagicBlockSmokeAuthorization(input: {
	readonly stateDirectory: string;
	readonly authorizationNonce: string;
	readonly createdAt: string;
}): MagicBlockSmokeAuthorizedState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current && current.status !== "reconciled") {
			throw new Error("MagicBlock smoke state requires reconciliation");
		}
		if (current?.status === "reconciled") {
			archiveReconciledState(input.stateDirectory, current);
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
	readonly prepared: MagicBlockRetryableAuditFailure;
	readonly preparedAt: string;
}): MagicBlockSmokePendingState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (
			current?.status !== "active" ||
			current.authorizationNonce !== requireNonce(input.authorizationNonce) ||
			input.prepared.status !== "retryable_failure" ||
			input.prepared.code !== "SUBMISSION_UNCONFIRMED" ||
			!input.prepared.signature ||
			!input.prepared.commitmentDigest ||
			!input.prepared.memo
		) {
			throw new Error("MagicBlock prepared smoke unavailable");
		}
		const state: MagicBlockSmokePendingState = {
			schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
			status: "pending",
			authorizationNonce: current.authorizationNonce,
			auditEventId: current.auditEventId,
			observationId: current.observationId,
			signer: requireSigner(input.signer),
			signature: requireSignature(input.prepared.signature),
			commitmentDigest: requireDigest(input.prepared.commitmentDigest),
			memo: requireMemo(input.prepared.memo),
			preparedAt: requireTimestamp(input.preparedAt),
		};
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
		};
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
}

export function reconcileMagicBlockSmoke(input: {
	readonly stateDirectory: string;
	readonly outcome: MagicBlockSmokeReconciledState["outcome"];
	readonly signature?: string;
	readonly reconciledAt: string;
}): MagicBlockSmokeReconciledState {
	return withStateLock(input.stateDirectory, () => {
		const current = readMagicBlockSmokeStateUnlocked(input.stateDirectory);
		if (current?.status === "reconciled") return current;
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
			(input.outcome === "confirmed" || input.outcome === "failed") &&
			current.signature === requireSignature(input.signature)
		) {
			state = {
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "reconciled",
				outcome: input.outcome,
				signature: current.signature,
				reconciledAt,
			};
		} else {
			throw new Error("MagicBlock smoke reconciliation is ambiguous");
		}
		writeStateAtomically(input.stateDirectory, state);
		return Object.freeze(state);
	});
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
): "confirmed" | "failed" | null {
	if (solana.status === "confirmed" || magicRouter.status === "confirmed") {
		return "confirmed";
	}
	return solana.code === "TRANSACTION_EXECUTION_FAILED" &&
		magicRouter.code === "TRANSACTION_EXECUTION_FAILED"
		? "failed"
		: null;
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

function archiveReconciledState(
	stateDirectory: string,
	state: MagicBlockSmokeReconciledState,
): void {
	const historyDirectory = join(stateDirectory, "history");
	mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
	const archivePath = join(
		historyDirectory,
		`${state.reconciledAt.replace(/[^0-9]/g, "")}-${randomUUID()}.json`,
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
		case "pending":
			requireExactKeys(record, [
				"auditEventId",
				"authorizationNonce",
				"commitmentDigest",
				"memo",
				"observationId",
				"preparedAt",
				"schemaVersion",
				"signer",
				"signature",
				"status",
			]);
			return Object.freeze({
				schemaVersion: MAGICBLOCK_SMOKE_STATE_SCHEMA,
				status: "pending",
				authorizationNonce: requireNonce(record.authorizationNonce),
				auditEventId: requireId(record.auditEventId),
				observationId: requireId(record.observationId),
				signer: requireSigner(record.signer),
				signature: requireSignature(record.signature),
				commitmentDigest: requireDigest(record.commitmentDigest),
				memo: requireMemo(record.memo),
				preparedAt: requireTimestamp(record.preparedAt),
			});
		case "legacy_pending":
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
			});
		case "reconciled": {
			const hasSignature = record.signature !== undefined;
			requireExactKeys(
				record,
				hasSignature
					? [
							"outcome",
							"reconciledAt",
							"schemaVersion",
							"signature",
							"status",
						]
					: ["outcome", "reconciledAt", "schemaVersion", "status"],
			);
			if (
				!["confirmed", "failed", "not_submitted"].includes(
					String(record.outcome),
				) ||
				(record.outcome === "not_submitted") !== !hasSignature
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
			});
		}
		default:
			throw new Error("MagicBlock smoke state unavailable");
	}
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
