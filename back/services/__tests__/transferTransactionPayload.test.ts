import { describe, expect, it, vi } from "vitest";
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	VersionedTransaction,
} from "@solana/web3.js";

import { buildSolTransferTransactionPayload } from "../solana/transactions/transferTransactionPayload";

describe("buildSolTransferTransactionPayload", () => {
	it("builds a devnet unsigned VersionedTransaction payload for SOL transfer", async () => {
		const source = Keypair.generate();
		const recipient = Keypair.generate();
		vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValueOnce({
			blockhash: Keypair.generate().publicKey.toBase58(),
			lastValidBlockHeight: 1,
		} as never);

		const result = await buildSolTransferTransactionPayload({
			candidateId: "candidate-transfer-payload",
			network: "devnet",
			sourceWallet: source.publicKey.toBase58(),
			recipientAddress: recipient.publicKey.toBase58(),
			amountSol: 0.1,
			rpcUrl: "https://api.devnet.solana.com",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.lamports).toBe(0.1 * LAMPORTS_PER_SOL);
		expect(result.payload.encoding).toBe("base64");
		expect(result.payload.actionHash).toMatch(/^[0-9a-f]{64}$/);

		const tx = VersionedTransaction.deserialize(
			Buffer.from(result.payload.unsignedVersionedTransaction, "base64"),
		);
		expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(
			source.publicKey.toBase58(),
		);
		expect(tx.message.staticAccountKeys).toEqual(
			expect.arrayContaining([recipient.publicKey]),
		);
	});

	it("does not build payloads outside devnet", async () => {
		const source = Keypair.generate();
		const recipient = Keypair.generate();

		const result = await buildSolTransferTransactionPayload({
			candidateId: "candidate-mainnet-transfer",
			network: "mainnet-beta",
			sourceWallet: source.publicKey.toBase58(),
			recipientAddress: recipient.publicKey.toBase58(),
			amountSol: 0.1,
			rpcUrl: "https://api.mainnet-beta.solana.com",
		});

		expect(result).toEqual({
			ok: false,
			reason: "TRANSFER_PAYLOAD_UNSUPPORTED_NETWORK",
		});
	});
});
