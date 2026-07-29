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
	type MagicBlockRetryableAuditFailure,
} from "./magicBlockOnchainAuditContracts";
import { MAGICBLOCK_ROUTER_URL } from "./magicBlockDevnetPreflightTypes";

const COMMITMENT_DOMAIN = "compass.magicblock-audit-commitment/v1\0";
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export type MagicBlockRouterRpc = (
	method: string,
	params: readonly unknown[],
) => Promise<unknown>;

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
	if (
		!Number.isSafeInteger(confirmationAttempts) ||
		confirmationAttempts < 1 ||
		confirmationAttempts > 20
	) {
		throw new Error("MagicBlock on-chain audit unavailable");
	}

	return {
		async register(details, onPrepared) {
			let materialized:
				| ReturnType<typeof materializeMagicBlockAuditCommitment>
				| undefined;
			let signature: string | undefined;
			try {
				materialized = materializeMagicBlockAuditCommitment(details);
				const latest = asRecord(
					await routerRpc("getLatestBlockhash", [{ commitment: "confirmed" }]),
				);
				const value = asRecord(latest.value);
				if (typeof value.blockhash !== "string") return retry("ROUTER_UNAVAILABLE");

				const transaction = new Transaction({
					feePayer: input.signer.publicKey,
					recentBlockhash: value.blockhash,
				}).add(
					new TransactionInstruction({
						programId: new PublicKey(MAGICBLOCK_MEMO_PROGRAM_ID),
						keys: [{ pubkey: input.signer.publicKey, isSigner: true, isWritable: false }],
						data: Buffer.from(materialized.memo, "utf8"),
					}),
				);
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
				return await verifyTransaction({
					rpc: solanaRpc,
					signature,
					signerAddress,
					expectedCommitmentDigest: materialized.commitmentDigest,
					expectedMemo: materialized.memo,
					now,
					confirmationAttempts,
					waitBetweenAttempts,
				});
			} catch {
				return retry("ROUTER_UNAVAILABLE", {
					...(signature ? { signature } : {}),
					...(materialized
						? {
								commitmentDigest: materialized.commitmentDigest,
								memo: materialized.memo,
							}
						: {}),
				});
			}
		},

		async verify({ signature, expectedCommitmentDigest, expectedMemo }) {
			if (!SIGNATURE.test(signature)) return retry("TRANSACTION_VERIFICATION_FAILED");
			try {
				return await verifyTransaction({
					rpc: solanaRpc,
					signature,
					signerAddress,
					expectedCommitmentDigest,
					expectedMemo,
					now,
					confirmationAttempts,
					waitBetweenAttempts,
				});
			} catch {
				return retry("ROUTER_UNAVAILABLE");
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
		const response = await fetchImpl(MAGICBLOCK_ROUTER_URL, {
			method: "POST",
			redirect: "error",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
		});
		if (
			response.status !== 200 ||
			response.redirected ||
			response.url !== MAGICBLOCK_ROUTER_URL
		) {
			throw new Error("Magic Router unavailable");
		}
		const body = asRecord(await response.json());
		if (body.error !== undefined) throw new Error("Magic Router RPC error");
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
			return retry("TRANSACTION_VERIFICATION_FAILED", {
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
	code: "SIGNER_UNAVAILABLE" | "ROUTER_UNAVAILABLE" | "SUBMISSION_UNCONFIRMED" | "TRANSACTION_VERIFICATION_FAILED",
	context: {
		readonly signature?: string;
		readonly commitmentDigest?: string;
		readonly memo?: string;
	} = {},
): MagicBlockRetryableAuditFailure {
	return Object.freeze({
		status: "retryable_failure",
		retryable: true,
		code,
		...context,
	});
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
