import bs58 from "bs58";

import { isCanonicalSolanaPublicKey, isCanonicalTimestamp, isDigest } from "./magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_PREFIX,
	MAGICBLOCK_DEVNET_ROUTER_URL,
	MAGICBLOCK_MEMO_PROGRAM_ID,
	MAGICBLOCK_READ_RPC_MAX_RESPONSE_BYTES,
	MAGICBLOCK_READ_RPC_METHODS,
	MAGICBLOCK_READ_RPC_TIMEOUT_MS,
	SOLANA_DEVNET_RPC_URL,
	type MagicBlockAuditProofVerificationRequest,
	type MagicBlockConfirmedAuditProof,
	type MagicBlockFinalizedAuditProofVerifier,
	type MagicBlockReadEndpoint,
	type MagicBlockReadProofFailure,
	type MagicBlockReadProofResult,
	type MagicBlockReadRpc,
} from "./magicBlockAuditProofVerificationContracts";

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

class ReadRpcUnavailable extends Error {
	constructor(readonly endpoint: MagicBlockReadEndpoint) { super("audit proof endpoint unavailable"); }
}

export function createSolanaDevnetReadRpc(input: ReadRpcTransportInput = {}): MagicBlockReadRpc {
	return createBoundedReadRpc("solana_devnet", SOLANA_DEVNET_RPC_URL, input);
}

export function createMagicRouterReadRpc(input: ReadRpcTransportInput = {}): MagicBlockReadRpc {
	return createBoundedReadRpc("magic_router", MAGICBLOCK_DEVNET_ROUTER_URL, input);
}

export type ReadRpcTransportInput = {
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
	readonly maximumResponseBytes?: number;
};

function createBoundedReadRpc(
	endpoint: MagicBlockReadEndpoint,
	url: typeof SOLANA_DEVNET_RPC_URL | typeof MAGICBLOCK_DEVNET_ROUTER_URL,
	input: ReadRpcTransportInput,
): MagicBlockReadRpc {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const timeoutMs = input.timeoutMs ?? MAGICBLOCK_READ_RPC_TIMEOUT_MS;
	const maximumResponseBytes = input.maximumResponseBytes ?? MAGICBLOCK_READ_RPC_MAX_RESPONSE_BYTES;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 || !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > MAGICBLOCK_READ_RPC_MAX_RESPONSE_BYTES) throw new Error("read RPC configuration unavailable");
	let requestId = 0;
	return async (method, params) => {
		if (!MAGICBLOCK_READ_RPC_METHODS.includes(method)) throw new ReadRpcUnavailable(endpoint);
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => { controller.abort(); reject(new ReadRpcUnavailable(endpoint)); }, timeoutMs);
		});
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await Promise.race([
				fetchImpl(url, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) }),
				timeout,
			]);
			if (response.status !== 200 || response.redirected || response.url !== url) throw new ReadRpcUnavailable(endpoint);
			const contentLength = response.headers.get("content-length");
			if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > maximumResponseBytes)) throw new ReadRpcUnavailable(endpoint);
			if (!response.body) throw new ReadRpcUnavailable(endpoint);
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			for (;;) {
				const chunk = await Promise.race([reader.read(), timeout]);
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > maximumResponseBytes) throw new ReadRpcUnavailable(endpoint);
				chunks.push(chunk.value);
			}
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			let body: Record<string, unknown>;
			try { body = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
			catch { throw new ReadRpcUnavailable(endpoint); }
			if (body.error !== undefined || !("result" in body)) throw new ReadRpcUnavailable(endpoint);
			return body.result;
		} catch (error) {
			if (reader) cancelReaderBestEffort(reader, "audit proof read stopped");
			if (error instanceof ReadRpcUnavailable) throw error;
			throw new ReadRpcUnavailable(endpoint);
		} finally {
			if (timer) clearTimeout(timer);
			if (reader) releaseReaderBestEffort(reader);
		}
	};
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
	try {
		void reader.cancel(reason).then(
			() => releaseReaderBestEffort(reader),
			() => releaseReaderBestEffort(reader),
		);
	} catch { releaseReaderBestEffort(reader); }
	queueMicrotask(() => releaseReaderBestEffort(reader));
}

function releaseReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try { reader.releaseLock(); } catch { /* A pending read releases after best-effort cancellation settles. */ }
}

export function createMagicBlockFinalizedAuditProofVerifier(input: {
	readonly solanaRpc?: MagicBlockReadRpc;
	readonly magicRouterRpc?: MagicBlockReadRpc;
	readonly now?: () => string;
} = {}): MagicBlockFinalizedAuditProofVerifier {
	const now = input.now ?? (() => new Date().toISOString());
	const solanaRpc = input.solanaRpc ?? createSolanaDevnetReadRpc();
	const magicRouterRpc = input.magicRouterRpc ?? createMagicRouterReadRpc();
	return {
		async verify(request) {
			if (!SIGNATURE.test(request.signature) || !isCanonicalSolanaPublicKey(request.expectedSigner)) return failure("TRANSACTION_VERIFICATION_FAILED");
			const [solana, router] = await Promise.all([
				verifyEndpoint("solana_devnet", solanaRpc, request, now),
				verifyEndpoint("magic_router", magicRouterRpc, request, now),
			]);
			if (solana.status !== "confirmed" || router.status !== "confirmed") {
				if (solana.status !== "confirmed" && router.status !== "confirmed" && solana.code === "TRANSACTION_EXECUTION_FAILED" && router.code === "TRANSACTION_EXECUTION_FAILED") return failure("TRANSACTION_EXECUTION_FAILED");
				return solana.status !== "confirmed" ? solana : router as MagicBlockReadProofFailure;
			}
			if (solana.signature !== router.signature || solana.signer !== router.signer || solana.slot !== router.slot || solana.commitmentDigest !== router.commitmentDigest || solana.memo !== router.memo) return failure("TRANSACTION_VERIFICATION_FAILED");
			const verifiedAt = now();
			if (!isCanonicalTimestamp(verifiedAt)) return failure("TRANSACTION_VERIFICATION_FAILED");
			return Object.freeze({ ...solana, verifiedAt });
		},
	};
}

async function verifyEndpoint(endpoint: MagicBlockReadEndpoint, rpc: MagicBlockReadRpc, request: MagicBlockAuditProofVerificationRequest, now: () => string): Promise<MagicBlockReadProofResult> {
	try {
		const statuses = asRecord(await rpc("getSignatureStatuses", [[request.signature], { searchTransactionHistory: true }]));
		const status = asRecord(Array.isArray(statuses.value) ? statuses.value[0] : undefined);
		if (status.confirmationStatus !== "finalized" || !Number.isSafeInteger(status.slot)) return failure("SUBMISSION_UNCONFIRMED", endpoint);
		const transaction = asRecord(await rpc("getTransaction", [request.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]));
		const meta = asRecord(transaction.meta);
		if (status.err !== null || meta.err !== null) {
			return status.err !== null && status.err !== undefined && meta.err !== null && meta.err !== undefined && Number.isSafeInteger(transaction.slot)
				? failure("TRANSACTION_EXECUTION_FAILED", endpoint)
				: failure("TRANSACTION_VERIFICATION_FAILED", endpoint);
		}
		const tx = asRecord(transaction.transaction);
		const message = asRecord(tx.message);
		const signatures = Array.isArray(tx.signatures) ? tx.signatures : [];
		const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
		const header = asRecord(message.header);
		const instructions = Array.isArray(message.instructions) ? message.instructions.map(asRecord) : [];
		const instruction = instructions[0] ?? {};
		let memo: string | undefined;
		try { memo = typeof instruction.data === "string" ? Buffer.from(bs58.decode(instruction.data)).toString("utf8") : undefined; }
		catch { memo = undefined; }
		const commitmentDigest = parseCommitmentDigest(memo);
		const verifiedAt = now();
		if (
			Number(header.numRequiredSignatures) !== 1 || signatures.length !== 1 || signatures[0] !== request.signature ||
			accountKeys[0] !== request.expectedSigner || accountKeys[Number(instruction.programIdIndex)] !== MAGICBLOCK_MEMO_PROGRAM_ID ||
			instructions.length !== 1 || !Array.isArray(instruction.accounts) || instruction.accounts.length !== 1 || Number(instruction.accounts[0]) !== 0 ||
			typeof memo !== "string" || memo !== request.expectedMemo || !isDigest(commitmentDigest) || commitmentDigest !== request.expectedCommitmentDigest ||
			!Number.isSafeInteger(transaction.slot) || Number(transaction.slot) !== Number(status.slot) || !isCanonicalTimestamp(verifiedAt)
		) return failure("TRANSACTION_VERIFICATION_FAILED", endpoint);
		const proof: MagicBlockConfirmedAuditProof = { status: "confirmed", cluster: "devnet", routerUrl: MAGICBLOCK_DEVNET_ROUTER_URL, signature: request.signature, signer: request.expectedSigner, slot: Number(transaction.slot), commitmentDigest, memo, verifiedAt };
		return Object.freeze(proof);
	} catch (error) {
		return failure(error instanceof ReadRpcUnavailable ? "ROUTER_UNAVAILABLE" : "TRANSACTION_VERIFICATION_FAILED", endpoint);
	}
}

function parseCommitmentDigest(memo: string | undefined): string | undefined {
	if (!memo?.startsWith(MAGICBLOCK_AUDIT_COMMITMENT_PREFIX)) return undefined;
	try { const value = asRecord(JSON.parse(memo.slice(MAGICBLOCK_AUDIT_COMMITMENT_PREFIX.length))); return typeof value.c === "string" ? value.c : undefined; }
	catch { return undefined; }
}

function failure(code: MagicBlockReadProofFailure["code"], endpoint?: MagicBlockReadEndpoint): MagicBlockReadProofFailure {
	return Object.freeze({ status: "retryable_failure", retryable: true, code, ...(endpoint ? { endpoint } : {}) });
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
