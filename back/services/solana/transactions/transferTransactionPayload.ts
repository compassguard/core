import { createHash } from "node:crypto";

import {
	Connection,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";

import type {
	BuildSolTransferTransactionPayloadInput,
	BuildSolTransferTransactionPayloadResult,
} from "./transferTransactionPayloadTypes";

export async function buildSolTransferTransactionPayload(
	input: BuildSolTransferTransactionPayloadInput,
): Promise<BuildSolTransferTransactionPayloadResult> {
	if (input.network !== "devnet") {
		return { ok: false, reason: "TRANSFER_PAYLOAD_UNSUPPORTED_NETWORK" };
	}

	const lamports = Math.round(input.amountSol * LAMPORTS_PER_SOL);
	if (!Number.isSafeInteger(lamports) || lamports <= 0) {
		return { ok: false, reason: "TRANSFER_PAYLOAD_INVALID_AMOUNT" };
	}

	let sourcePublicKey: PublicKey;
	let recipientPublicKey: PublicKey;
	try {
		sourcePublicKey = new PublicKey(input.sourceWallet);
		recipientPublicKey = new PublicKey(input.recipientAddress);
	} catch {
		return { ok: false, reason: "TRANSFER_PAYLOAD_INVALID_WALLET" };
	}

	try {
		const connection = new Connection(input.rpcUrl);
		const { blockhash } = await connection.getLatestBlockhash();
		const message = new TransactionMessage({
			payerKey: sourcePublicKey,
			recentBlockhash: blockhash,
			instructions: [
				SystemProgram.transfer({
					fromPubkey: sourcePublicKey,
					toPubkey: recipientPublicKey,
					lamports,
				}),
			],
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const unsignedBytes = tx.serialize();
		const unsignedVersionedTransaction = Buffer.from(unsignedBytes).toString(
			"base64",
		);

		return {
			ok: true,
			payload: {
				encoding: "base64",
				actionHash: hashTransferAction({ ...input, lamports }),
				unsignedVersionedTransaction,
			},
			lamports,
			sourceWallet: sourcePublicKey.toBase58(),
			recipientAddress: recipientPublicKey.toBase58(),
		};
	} catch {
		return { ok: false, reason: "TRANSFER_PAYLOAD_BUILD_FAILED" };
	}
}

function hashTransferAction(input: BuildSolTransferTransactionPayloadInput & {
	lamports: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				candidateId: input.candidateId,
				network: input.network,
				sourceWallet: input.sourceWallet,
				recipientAddress: input.recipientAddress,
				lamports: input.lamports,
			}),
		)
		.digest("hex");
}