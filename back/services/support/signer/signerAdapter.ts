import { Keypair, VersionedTransaction, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
	SignerAdapter,
	SignerAdapterConfig,
	CreateSignerAdapterResult,
} from "./signerAdapterContracts";

// LocalKeypairAdapter — devnet demo only, never product custody.
// Guarded by COMPASS_LOCAL_SIGNER_ENABLED=true env flag.
// Throws LOCAL_SIGNER_MAINNET_FORBIDDEN for any non-devnet RPC.
export class LocalKeypairAdapter implements SignerAdapter {
	private keypair: Keypair;
	private connection: Connection;

	constructor(secretKey: Uint8Array, rpcUrl: string) {
		this.keypair = Keypair.fromSecretKey(secretKey);
		this.connection = new Connection(rpcUrl);
	}

	async getAddress(): Promise<string> {
		return this.keypair.publicKey.toBase58();
	}

	async signTransaction(
		tx: VersionedTransaction,
	): Promise<VersionedTransaction> {
		tx.sign([this.keypair]);
		return tx;
	}

	async signAndSendTransaction(tx: VersionedTransaction): Promise<string> {
		const signedTx = await this.signTransaction(tx);
		const signature = await this.connection.sendRawTransaction(signedTx.serialize());
		return signature;
	}
}

// Resolve secret key from base58 env vars.
// Returns undefined if the env var is absent or cannot be decoded.
function resolveSecretKeyFromEnv(): Uint8Array | undefined {
	const envKey =
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 ??
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY;
	if (!envKey) return undefined;
	try {
		return new Uint8Array(bs58.decode(envKey));
	} catch {
		return undefined;
	}
}

function matchesConfiguredPublicKey(secretKey: Uint8Array): boolean {
	const expectedPublicKey = process.env.COMPASS_LOCAL_SIGNER_PUBLIC_KEY?.trim();
	if (!expectedPublicKey) return true;

	try {
		const derivedPublicKey = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
		return derivedPublicKey === expectedPublicKey;
	} catch {
		return false;
	}
}

export function createSignerAdapter(
	config?: SignerAdapterConfig,
): CreateSignerAdapterResult {
	const isEnabled = process.env.COMPASS_LOCAL_SIGNER_ENABLED === "true";
	const rpcUrl = config?.rpcUrl || process.env.SOLANA_RPC_URL;

	if (!isEnabled) {
		return { ok: false, reason: "LOCAL_SIGNER_NOT_CONFIGURED" };
	}

	if (rpcUrl?.includes("mainnet")) {
		return { ok: false, reason: "LOCAL_SIGNER_MAINNET_FORBIDDEN" };
	}

	// Explicit config takes priority over env var fallback.
	const secretKey = config?.localSecretKey ?? resolveSecretKeyFromEnv();

	if (!secretKey) {
		return { ok: false, reason: "LOCAL_SIGNER_NOT_CONFIGURED" };
	}

	if (!matchesConfiguredPublicKey(secretKey)) {
		return { ok: false, reason: "LOCAL_SIGNER_PUBLIC_KEY_MISMATCH" };
	}

	if (!rpcUrl) {
		return { ok: false, reason: "LOCAL_SIGNER_NOT_CONFIGURED" };
	}

	return {
		ok: true,
		adapter: new LocalKeypairAdapter(secretKey, rpcUrl),
	};
}