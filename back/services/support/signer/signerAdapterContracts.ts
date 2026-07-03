import type { VersionedTransaction } from "@solana/web3.js";

export interface SignerAdapter {
	/** Returns the base58 public key this adapter controls. */
	getAddress(): Promise<string>;

	/**
	 * Signs a transaction and returns the signed version.
	 * Does NOT submit to the network.
	 */
	signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;

	/**
	 * Optional: signs and submits. Implementations MUST be devnet-only in MVP.
	 * Returns the transaction signature string.
	 */
	signAndSendTransaction?(tx: VersionedTransaction): Promise<string>;
}

export type SignerAdapterConfig = {
	/** Keypair secret key bytes. Falls back to COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 env var (base58-encoded) when not provided. */
	localSecretKey?: Uint8Array;
	/** Defaults to process.env.SOLANA_RPC_URL. Used for network guard. */
	rpcUrl?: string;
};

export type CreateSignerAdapterResult =
	| { ok: true; adapter: SignerAdapter }
	| {
			ok: false;
			reason:
				| "LOCAL_SIGNER_NOT_CONFIGURED"
				| "LOCAL_SIGNER_MAINNET_FORBIDDEN"
				| "LOCAL_SIGNER_PUBLIC_KEY_MISMATCH";
	  };