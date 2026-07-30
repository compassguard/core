import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import {
	canonicalJson,
	isCanonicalTimestamp,
	isDigest,
	sha256Hex,
} from "./magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_PREFIX,
	MAGICBLOCK_MEMO_PROGRAM_ID,
	SOLANA_DEVNET_RPC_URL,
	type MagicBlockAuditCommitmentDetails,
	type MagicBlockConfirmedAuditProof,
	type MagicBlockOnchainAuditRegistration,
	type MagicBlockOnchainAuditSubmitter,
	type MagicBlockOnchainAuditVerifier,
	type MagicBlockRetryableAuditFailure,
	type MagicBlockRouterDiagnostics,
	type MagicBlockRouterRpc,
} from "./magicBlockOnchainAuditContracts";
import { MAGICBLOCK_ROUTER_URL } from "./magicBlockDevnetPreflightTypes";
import {
	createMagicBlockRouterDiagnostics,
	isMagicBlockRouterPreflightRejection,
	MagicBlockRouterRpcError,
} from "./magicBlockRouterDiagnostics";

const COMMITMENT_DOMAIN = "compass.magicblock-audit-commitment/v1\0";
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function materializeMagicBlockAuditCommitment(
	details: MagicBlockAuditCommitmentDetails,
): { readonly canonicalDetails: string; readonly commitmentDigest: string; readonly memo: string } {
	const canonicalDetails = canonicalJson(details);
	const commitmentDigest = sha256Hex(COMMITMENT_DOMAIN, canonicalDetails);
	const publicCommitment = canonicalJson({
		a: details.auditEventId,
		c: commitmentDigest,
		l: details.ledgerDigest,
		o: details.outcome === "review_required" ? "review" : "incompatible",
		p: details.previousLedgerDigest,
		v: 1,
	});
	return {
		canonicalDetails,
		commitmentDigest,
		memo: `${MAGICBLOCK_AUDIT_COMMITMENT_PREFIX}${publicCommitment}`,
	};
}

export function createMagicBlockOnchainAuditSubmitter(input: {
	readonly signer: Keypair;
	readonly routerRpc?: MagicBlockRouterRpc;
	readonly solanaRpc?: MagicBlockRouterRpc;
	readonly now?: () => string;
	readonly confirmationAttempts?: number;
	readonly waitBetweenAttempts?: () => Promise<void>;
}): MagicBlockOnchainAuditSubmitter {
	const routerRpc = input.routerRpc ?? createMagicBlockRouterRpc();
	const solanaRpc = input.solanaRpc ?? createSolanaDevnetRpc();
	const now = input.now ?? (() => new Date().toISOString());
	const signerAddress = input.signer.publicKey.toBase58();
	const confirmationAttempts = input.confirmationAttempts ?? 4;
	const waitBetweenAttempts =
		input.waitBetweenAttempts ??
		(() => new Promise((resolve) => setTimeout(resolve, 500)));
	validateConfirmationAttempts(confirmationAttempts);
	const verifier = createMagicBlockOnchainAuditVerifier({
		rpc: solanaRpc,
		now,
		confirmationAttempts,
		waitBetweenAttempts,
	});

	return {
		async register(details, onPrepared) {
			let materialized:
				| ReturnType<typeof materializeMagicBlockAuditCommitment>
				| undefined;
			let signature: string | undefined;
			try {
				materialized = materializeMagicBlockAuditCommitment(details);
				const transaction = new Transaction();
				transaction.feePayer = input.signer.publicKey;
				transaction.add(
					new TransactionInstruction({
						programId: new PublicKey(MAGICBLOCK_MEMO_PROGRAM_ID),
						keys: [{ pubkey: input.signer.publicKey, isSigner: true, isWritable: false }],
						data: Buffer.from(materialized.memo, "utf8"),
					}),
				);
				const routingAccounts = deriveMagicBlockRoutingAccounts(transaction);
				const latest = asRecord(
					await routerRpc("getBlockhashForAccounts", [routingAccounts]),
				);
				if (
					!isCanonicalBlockhash(latest.blockhash) ||
					!Number.isSafeInteger(latest.lastValidBlockHeight) ||
					Number(latest.lastValidBlockHeight) < 0
				) {
					return retry("ROUTER_UNAVAILABLE", {
						routerDiagnostics: createMagicBlockRouterDiagnostics({
							rpcMethod: "getBlockhashForAccounts",
							message: "Magic Router returned an invalid blockhash response",
						}),
					});
				}
				transaction.recentBlockhash = latest.blockhash;
				transaction.sign(input.signer);
				signature = transaction.signature
					? bs58.encode(transaction.signature)
					: "";
				if (!SIGNATURE.test(signature)) return retry("SIGNER_UNAVAILABLE");
				if (onPrepared) {
					const persisted = await onPrepared(
						retry("SUBMISSION_UNCONFIRMED", {
							signature,
							commitmentDigest: materialized.commitmentDigest,
							memo: materialized.memo,
						}),
					);
					if (
						persisted.signature !== signature ||
						persisted.commitmentDigest !==
							materialized.commitmentDigest ||
						persisted.memo !== materialized.memo
					) {
						return persisted;
					}
				}
				const encoded = transaction.serialize().toString("base64");
				const sent = await routerRpc("sendTransaction", [
					encoded,
					{
						encoding: "base64",
						skipPreflight: false,
						preflightCommitment: "confirmed",
						maxRetries: 3,
					},
				]);
				if (sent !== signature) {
					return retry("SUBMISSION_UNCONFIRMED", {
						signature,
						commitmentDigest: materialized.commitmentDigest,
						memo: materialized.memo,
					});
				}
				return await verifier.verify({
					signature,
					expectedSigner: signerAddress,
					expectedCommitmentDigest: materialized.commitmentDigest,
					expectedMemo: materialized.memo,
				});
			} catch (error) {
				const routerError =
					error instanceof MagicBlockRouterRpcError ? error : undefined;
				return retry(
					routerError?.preflightRejected
						? "ROUTER_PREFLIGHT_REJECTED"
						: "ROUTER_UNAVAILABLE",
					{
					...(signature ? { signature } : {}),
					...(materialized
						? {
								commitmentDigest: materialized.commitmentDigest,
								memo: materialized.memo,
							}
						: {}),
						...(routerError
							? { routerDiagnostics: routerError.diagnostics }
							: {}),
					},
				);
			}
		},

		async verify({ signature, expectedCommitmentDigest, expectedMemo }) {
			return verifier.verify({
				signature,
				expectedSigner: signerAddress,
				expectedCommitmentDigest,
				expectedMemo,
			});
		},
	};
}

export function createMagicBlockOnchainAuditVerifier(input: {
	readonly rpc?: MagicBlockRouterRpc;
	readonly now?: () => string;
	readonly confirmationAttempts?: number;
	readonly waitBetweenAttempts?: () => Promise<void>;
}): MagicBlockOnchainAuditVerifier {
	const rpc = input.rpc ?? createSolanaDevnetRpc();
	const now = input.now ?? (() => new Date().toISOString());
	const confirmationAttempts = input.confirmationAttempts ?? 4;
	const waitBetweenAttempts =
		input.waitBetweenAttempts ??
		(() => new Promise((resolve) => setTimeout(resolve, 500)));
	validateConfirmationAttempts(confirmationAttempts);

	return {
		async verify({
			signature,
			expectedSigner,
			expectedCommitmentDigest,
			expectedMemo,
		}) {
			if (
				!SIGNATURE.test(signature) ||
				!isCanonicalPublicKey(expectedSigner)
			) {
				return retry("TRANSACTION_VERIFICATION_FAILED");
			}
			try {
				return await verifyTransaction({
					rpc,
					signature,
					signerAddress: expectedSigner,
					expectedCommitmentDigest,
					expectedMemo,
					now,
					confirmationAttempts,
					waitBetweenAttempts,
				});
			} catch (error) {
				const routerError =
					error instanceof MagicBlockRouterRpcError ? error : undefined;
				return retry("ROUTER_UNAVAILABLE", {
					...(routerError
						? { routerDiagnostics: routerError.diagnostics }
						: {}),
				});
			}
		},
	};
}

export function createMagicBlockAuditSignerFromEnv(
	getEnv: (key: string) => string | undefined = (key) => process.env[key],
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Keypair | null {
	const file = getEnv(
		"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY_FILE",
	)?.trim();
	let encoded = getEnv(
		"COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_SECRET_KEY",
	)?.trim();
	if (encoded && file) return null;
	if (!encoded && file) {
		if (!isAbsolute(file)) return null;
		try {
			encoded = readFile(file);
		} catch {
			return null;
		}
	}
	if (!encoded) return null;
	try {
		if (new TextEncoder().encode(encoded).byteLength > 1_024) return null;
		encoded = encoded.trim();
		const bytes = encoded.startsWith("[")
			? Uint8Array.from(JSON.parse(encoded) as number[])
			: bs58.decode(encoded);
		const signer = Keypair.fromSecretKey(bytes);
		const expected = getEnv("COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY")?.trim();
		if (expected && signer.publicKey.toBase58() !== expected) return null;
		return signer;
	} catch {
		return null;
	}
}

export function createMagicBlockRouterRpc(
	fetchImpl: typeof fetch = globalThis.fetch,
): MagicBlockRouterRpc {
	let requestId = 0;
	return async (method, params) => {
		let response: Response;
		try {
			response = await fetchImpl(MAGICBLOCK_ROUTER_URL, {
				method: "POST",
				redirect: "error",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
			});
		} catch {
			throw new MagicBlockRouterRpcError(
				requireRouterDiagnostics({
					rpcMethod: method,
					message: "Magic Router transport failed",
				}),
				false,
			);
		}
		const safeRequestId =
			response.headers.get("x-request-id") ??
			response.headers.get("x-correlation-id") ??
			undefined;
		let body: Record<string, unknown> = {};
		let invalidJson = false;
		try {
			body = asRecord(await response.json());
		} catch {
			invalidJson = true;
		}
		const rpcError = asRecord(body.error);
		const diagnostics = requireRouterDiagnostics({
			rpcMethod: method,
			httpStatus: response.status,
			rpcErrorCode: rpcError.code,
			message:
				rpcError.message ??
				(invalidJson ? "Magic Router returned invalid JSON" : undefined),
			requestId: safeRequestId,
		});
		if (response.redirected || response.url !== MAGICBLOCK_ROUTER_URL) {
			throw new MagicBlockRouterRpcError(diagnostics, false);
		}
		if (response.status !== 200) {
			throw new MagicBlockRouterRpcError(
				diagnostics,
				body.error !== undefined &&
					isMagicBlockRouterPreflightRejection(diagnostics),
			);
		}
		if (body.error !== undefined) {
			throw new MagicBlockRouterRpcError(
				diagnostics,
				isMagicBlockRouterPreflightRejection(diagnostics),
			);
		}
		if (invalidJson) throw new MagicBlockRouterRpcError(diagnostics, false);
		return body.result;
	};
}

export function createSolanaDevnetRpc(
	fetchImpl: typeof fetch = globalThis.fetch,
): MagicBlockRouterRpc {
	return createLiteralJsonRpc(SOLANA_DEVNET_RPC_URL, fetchImpl);
}

function createLiteralJsonRpc(
	url: typeof SOLANA_DEVNET_RPC_URL,
	fetchImpl: typeof fetch,
): MagicBlockRouterRpc {
	let requestId = 0;
	return async (method, params) => {
		const response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
		});
		if (response.status !== 200 || response.redirected || response.url !== url) {
			throw new Error("Solana devnet RPC unavailable");
		}
		const body = asRecord(await response.json());
		if (body.error !== undefined) throw new Error("Solana devnet RPC error");
		return body.result;
	};
}

async function verifyTransaction(input: {
	readonly rpc: MagicBlockRouterRpc;
	readonly signature: string;
	readonly signerAddress: string;
	readonly expectedCommitmentDigest?: string;
	readonly expectedMemo?: string;
	readonly now: () => string;
	readonly confirmationAttempts: number;
	readonly waitBetweenAttempts: () => Promise<void>;
}): Promise<MagicBlockOnchainAuditRegistration> {
	let confirmed = false;
	for (let attempt = 0; attempt < input.confirmationAttempts; attempt += 1) {
		const statusResponse = asRecord(
			await input.rpc("getSignatureStatuses", [
				[input.signature],
				{ searchTransactionHistory: true },
			]),
		);
		const statuses = Array.isArray(statusResponse.value)
			? statusResponse.value
			: [];
		const status = asRecord(statuses[0]);
		if (status.err !== undefined && status.err !== null) {
			return retry("TRANSACTION_EXECUTION_FAILED", {
				signature: input.signature,
				...(input.expectedCommitmentDigest
					? { commitmentDigest: input.expectedCommitmentDigest }
					: {}),
				...(input.expectedMemo ? { memo: input.expectedMemo } : {}),
			});
		}
		if (["confirmed", "finalized"].includes(String(status.confirmationStatus))) {
			confirmed = true;
			break;
		}
		if (attempt + 1 < input.confirmationAttempts) {
			await input.waitBetweenAttempts();
		}
	}
	if (!confirmed) {
		return retry("SUBMISSION_UNCONFIRMED", {
			signature: input.signature,
			...(input.expectedCommitmentDigest
				? { commitmentDigest: input.expectedCommitmentDigest }
				: {}),
			...(input.expectedMemo ? { memo: input.expectedMemo } : {}),
		});
	}
	const transaction = asRecord(
		await input.rpc("getTransaction", [
			input.signature,
			{
				commitment: "confirmed",
				encoding: "json",
				maxSupportedTransactionVersion: 0,
			},
		]),
	);
	const meta = asRecord(transaction.meta);
	const tx = asRecord(transaction.transaction);
	const message = asRecord(tx.message);
	const accountKeys = Array.isArray(message.accountKeys)
		? message.accountKeys
		: [];
	const header = asRecord(message.header);
	const requiredSignatures = Number(header.numRequiredSignatures);
	const signerIndex = accountKeys.findIndex(
		(entry) => entry === input.signerAddress,
	);
	const instructions = Array.isArray(message.instructions)
		? message.instructions
		: [];
	const memoInstruction = instructions
		.map(asRecord)
		.find((instruction) => {
			const programIndex = Number(instruction.programIdIndex);
			const accounts = Array.isArray(instruction.accounts)
				? instruction.accounts.map(Number)
				: [];
			return (
				accountKeys[programIndex] === MAGICBLOCK_MEMO_PROGRAM_ID &&
				accounts.includes(signerIndex)
			);
		});
	let memo: string | undefined;
	try {
		memo =
			typeof memoInstruction?.data === "string"
				? Buffer.from(bs58.decode(memoInstruction.data)).toString("utf8")
				: undefined;
	} catch {
		memo = undefined;
	}
	const parsedCommitment = parsePublicCommitment(memo);
	const commitmentDigest = parsedCommitment?.c;
	const verifiedAt = input.now();
	if (meta.err !== undefined && meta.err !== null) {
		return retry("TRANSACTION_EXECUTION_FAILED", {
			signature: input.signature,
			...(input.expectedCommitmentDigest
				? { commitmentDigest: input.expectedCommitmentDigest }
				: {}),
			...(input.expectedMemo ? { memo: input.expectedMemo } : {}),
		});
	}
	if (
		meta.err !== null ||
		!Number.isSafeInteger(requiredSignatures) ||
		signerIndex < 0 ||
		signerIndex >= requiredSignatures ||
		typeof memo !== "string" ||
		(input.expectedMemo !== undefined && memo !== input.expectedMemo) ||
		!isDigest(commitmentDigest) ||
		(input.expectedCommitmentDigest !== undefined &&
			commitmentDigest !== input.expectedCommitmentDigest) ||
		!isCanonicalTimestamp(verifiedAt) ||
		!Number.isSafeInteger(transaction.slot)
	) {
		return retry("TRANSACTION_VERIFICATION_FAILED");
	}
	const proof: MagicBlockConfirmedAuditProof = {
		status: "confirmed",
		cluster: "devnet",
		routerUrl: MAGICBLOCK_ROUTER_URL,
		signature: input.signature,
		signer: input.signerAddress,
		slot: transaction.slot as number,
		commitmentDigest,
		memo,
		verifiedAt,
	};
	return Object.freeze(proof);
}

function retry(
	code: MagicBlockRetryableAuditFailure["code"],
	context: {
		readonly signature?: string;
		readonly commitmentDigest?: string;
		readonly memo?: string;
		readonly routerDiagnostics?: MagicBlockRouterDiagnostics;
	} = {},
): MagicBlockRetryableAuditFailure {
	return Object.freeze({
		status: "retryable_failure",
		retryable: true,
		code,
		...context,
	});
}

export function deriveMagicBlockRoutingAccounts(
	transaction: Transaction,
): readonly string[] {
	if (!transaction.feePayer) {
		throw new Error("MagicBlock routing accounts unavailable");
	}
	const accounts = new Set<string>([transaction.feePayer.toBase58()]);
	for (const instruction of transaction.instructions) {
		for (const key of instruction.keys) {
			if (key.isWritable) accounts.add(key.pubkey.toBase58());
		}
	}
	return Object.freeze([...accounts]);
}

function requireRouterDiagnostics(input: {
	readonly rpcMethod: unknown;
	readonly httpStatus?: unknown;
	readonly rpcErrorCode?: unknown;
	readonly message?: unknown;
	readonly requestId?: unknown;
}): MagicBlockRouterDiagnostics {
	const diagnostics = createMagicBlockRouterDiagnostics(input);
	if (!diagnostics) throw new Error("Magic Router diagnostics unavailable");
	return diagnostics;
}

function isCanonicalBlockhash(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new PublicKey(value).toBase58() === value;
	} catch {
		return false;
	}
}

function isCanonicalPublicKey(value: unknown): value is string {
	return isCanonicalBlockhash(value);
}

function validateConfirmationAttempts(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > 20
	) {
		throw new Error("MagicBlock on-chain audit unavailable");
	}
}

function parsePublicCommitment(
	memo: string | undefined,
): { readonly c: string } | null {
	if (!memo?.startsWith(MAGICBLOCK_AUDIT_COMMITMENT_PREFIX)) return null;
	try {
		const value = JSON.parse(
			memo.slice(MAGICBLOCK_AUDIT_COMMITMENT_PREFIX.length),
		) as Record<string, unknown>;
		return typeof value.c === "string" ? { c: value.c } : null;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
