import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";

import { materializeMagicBlockAuditCommitment } from "../magicBlockAuditCommitment";
import { createMagicBlockFinalizedAuditProofVerifier, createMagicRouterReadRpc, createSolanaDevnetReadRpc } from "../magicBlockAuditProofVerification";
import { MAGICBLOCK_DEVNET_ROUTER_URL, MAGICBLOCK_MEMO_PROGRAM_ID, SOLANA_DEVNET_RPC_URL, type MagicBlockReadRpc } from "../magicBlockAuditProofVerificationContracts";

const NOW = "2026-08-01T12:00:00.000Z";
const SIGNATURE = "7".repeat(64);
const SIGNER = Keypair.generate().publicKey.toBase58();
const DETAILS = { schemaVersion: "compass.magicblock-audit-commitment/v1" as const, cluster: "devnet" as const, observationId: "obs_read_proof", auditEventId: "aud_read_proof", transactionDigest: "1".repeat(64), requestDigest: "2".repeat(64), resultDigest: "3".repeat(64), attestationDigest: "4".repeat(64), previousLedgerDigest: "5".repeat(64), ledgerDigest: "6".repeat(64), outcome: "review_required" as const };
const COMMITMENT = materializeMagicBlockAuditCommitment(DETAILS);
const REQUEST = { signature: SIGNATURE, expectedSigner: SIGNER, expectedCommitmentDigest: COMMITMENT.commitmentDigest, expectedMemo: COMMITMENT.memo };

describe("bounded read-only MagicBlock proof verification", () => {
	it.each([
		["Solana", createSolanaDevnetReadRpc, SOLANA_DEVNET_RPC_URL],
		["Router", createMagicRouterReadRpc, MAGICBLOCK_DEVNET_ROUTER_URL],
	] as const)("bounds %s headers/body, rejects redirects/oversize/malformed JSON", async (_name, create, url) => {
		const cases: Array<typeof fetch> = [
			vi.fn(() => new Promise<Response>(() => undefined)) as never,
			vi.fn(async () => fixedResponse(new ReadableStream({ pull: () => new Promise(() => undefined) }), url)) as never,
			vi.fn(async () => fixedResponse(JSON.stringify({ result: null }), url, { headers: { "content-length": "70000" } })) as never,
			vi.fn(async () => fixedResponse("x".repeat(65), url)) as never,
			vi.fn(async () => fixedResponse("{", url)) as never,
			vi.fn(async () => fixedResponse(JSON.stringify({ result: null }), `${url}redirected`, { redirected: true })) as never,
		];
		for (const fetchImpl of cases) {
			const rpc = create({ fetchImpl, timeoutMs: 5, maximumResponseBytes: 64 });
			await expect(rpc("getTransaction", [SIGNATURE])).rejects.toThrow("audit proof endpoint unavailable");
		}
	});

	it.each([
		["Solana", createSolanaDevnetReadRpc, SOLANA_DEVNET_RPC_URL],
		["Router", createMagicRouterReadRpc, MAGICBLOCK_DEVNET_ROUTER_URL],
	] as const)("settles the %s body deadline even when read and cancellation both stall", async (_name, create, url) => {
		let cancellationAttempted = false;
		const stream = new ReadableStream<Uint8Array>({
			pull: () => new Promise(() => undefined),
			cancel: () => { cancellationAttempted = true; return new Promise(() => undefined); },
		});
		const rpc = create({ fetchImpl: vi.fn(async () => fixedResponse(stream, url)) as never, timeoutMs: 5, maximumResponseBytes: 64 });
		const outcome = rpc("getTransaction", [SIGNATURE]).then(() => "resolved", () => "rejected");
		await expect(Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve("deadline did not settle"), 100))])).resolves.toBe("rejected");
		expect(cancellationAttempted).toBe(true);
		expect(stream.locked).toBe(false);
	});

	it.each(["solana_devnet", "magic_router"] as const)("reports %s-only unavailable, unconfirmed, and execution failure", async (endpoint) => {
		for (const mode of ["unavailable", "unconfirmed", "failed"] as const) {
			const healthy = proofRpc();
			const selected = mode === "unavailable" ? (vi.fn(async () => { throw new Error("sensitive raw body"); }) as MagicBlockReadRpc) : proofRpc({ status: mode === "unconfirmed" ? { confirmationStatus: "confirmed", err: null, slot: 44 } : { confirmationStatus: "finalized", err: { InstructionError: [0, "InvalidArgument"] }, slot: 44 } });
			const result = await createMagicBlockFinalizedAuditProofVerifier({ solanaRpc: endpoint === "solana_devnet" ? selected : healthy, magicRouterRpc: endpoint === "magic_router" ? selected : healthy, now: () => NOW }).verify(REQUEST);
			expect(result).toMatchObject({ status: "retryable_failure", endpoint });
			expect(JSON.stringify(result)).not.toContain("sensitive raw body");
		}
	});

	it.each(["solana_devnet", "magic_router"] as const)("rejects %s-only signature/signer/Memo/digest/shape/slot mismatch", async (endpoint) => {
		const mutations = [
			{ signatures: ["8".repeat(64)] },
			{ signer: Keypair.generate().publicKey.toBase58() },
			{ memo: `${COMMITMENT.memo}x` },
			{ memo: COMMITMENT.memo.replace(COMMITMENT.commitmentDigest, "9".repeat(64)) },
			{ extraInstruction: true },
			{ transactionSlot: 45 },
		];
		for (const mutation of mutations) {
			const selected = proofRpc(mutation);
			const result = await createMagicBlockFinalizedAuditProofVerifier({ solanaRpc: endpoint === "solana_devnet" ? selected : proofRpc(), magicRouterRpc: endpoint === "magic_router" ? selected : proofRpc(), now: () => NOW }).verify(REQUEST);
			expect(result).toMatchObject({ status: "retryable_failure", endpoint, code: "TRANSACTION_VERIFICATION_FAILED" });
		}
	});

	it("returns success only on exact full endpoint agreement and calls no other RPC method", async () => {
		const solana = proofRpc();
		const router = proofRpc();
		await expect(createMagicBlockFinalizedAuditProofVerifier({ solanaRpc: solana, magicRouterRpc: router, now: () => NOW }).verify(REQUEST)).resolves.toMatchObject({ status: "confirmed", slot: 44, signer: SIGNER });
		for (const rpc of [solana, router]) expect((rpc as ReturnType<typeof vi.fn>).mock.calls.map(([method]) => method)).toEqual(["getSignatureStatuses", "getTransaction"]);
	});
});

function proofRpc(input: { readonly status?: Record<string, unknown>; readonly signatures?: string[]; readonly signer?: string; readonly memo?: string; readonly extraInstruction?: boolean; readonly transactionSlot?: number } = {}): MagicBlockReadRpc & ReturnType<typeof vi.fn> {
	return vi.fn(async (method: string) => {
		if (method === "getSignatureStatuses") return { value: [input.status ?? { confirmationStatus: "finalized", err: null, slot: 44 }] };
		const memo = input.memo ?? COMMITMENT.memo;
		return { slot: input.transactionSlot ?? 44, meta: { err: input.status?.err ?? null }, transaction: { signatures: input.signatures ?? [SIGNATURE], message: { accountKeys: [input.signer ?? SIGNER, MAGICBLOCK_MEMO_PROGRAM_ID], header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: 1, accounts: [0], data: bs58.encode(Buffer.from(memo)) }, ...(input.extraInstruction ? [{ programIdIndex: 1, accounts: [0], data: "x" }] : [])] } } };
	}) as MagicBlockReadRpc & ReturnType<typeof vi.fn>;
}

function fixedResponse(body: string | ReadableStream<Uint8Array>, url: string, options: { readonly headers?: HeadersInit; readonly redirected?: boolean } = {}): Response {
	const response = new Response(body, { status: 200, headers: options.headers });
	Object.defineProperty(response, "url", { value: url });
	Object.defineProperty(response, "redirected", { value: options.redirected ?? false });
	return response;
}
