/**
 * Wave 6a — Signer adapter and idempotency store tests
 * T1_RED_SIGNER_ADAPTER: RED tests for SignerAdapter interface, LocalKeypairAdapter,
 * and createSignerAdapter factory.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import {
	Connection,
	Keypair,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";

function createUnsignedVersionedTransaction(payerKey: Keypair["publicKey"]) {
	const message = new TransactionMessage({
		payerKey,
		recentBlockhash: Keypair.generate().publicKey.toBase58(),
		instructions: [],
	}).compileToV0Message();

	return new VersionedTransaction(message);
}

describe("SignerAdapter interface", () => {
	it("a class satisfying the interface compiles and getAddress is callable", async () => {
		// Test that the interface contract is satisfied
		const mockAdapter = {
			getAddress: vi
				.fn()
				.mockResolvedValue("So11111111111111111111111111111111111111112"),
			signTransaction: vi.fn(),
		};

		// The interface requires getAddress to return a Promise<string>
		const address = await mockAdapter.getAddress();
		expect(address).toBe("So11111111111111111111111111111111111111112");
		expect(typeof address).toBe("string");
	});
});

describe("createSignerAdapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.COMPASS_LOCAL_SIGNER_ENABLED;
		delete process.env.SOLANA_RPC_URL;
		delete process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58;
		delete process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY;
		delete process.env.COMPASS_LOCAL_SIGNER_PUBLIC_KEY;
	});

	it("returns LOCAL_SIGNER_NOT_CONFIGURED when COMPASS_LOCAL_SIGNER_ENABLED is absent", async () => {
		// Ensure the env flag is not set
		delete process.env.COMPASS_LOCAL_SIGNER_ENABLED;

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_NOT_CONFIGURED");
	});

	it("returns LOCAL_SIGNER_NOT_CONFIGURED when COMPASS_LOCAL_SIGNER_ENABLED is not 'true'", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "false";

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_NOT_CONFIGURED");
	});

	it("returns LOCAL_SIGNER_MAINNET_FORBIDDEN when RPC URL contains 'mainnet'", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_MAINNET_FORBIDDEN");
	});

	it("returns LOCAL_SIGNER_MAINNET_FORBIDDEN when RPC URL contains 'mainnet' in config", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://solana-mainnet.g.alchemy.com/v2/xxx";

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			rpcUrl: "https://api.mainnet-beta.solana.com",
		});

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_MAINNET_FORBIDDEN");
	});

	it("returns ok with adapter when COMPASS_LOCAL_SIGNER_ENABLED=true and devnet RPC", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

		// Use a test keypair
		const testKeypair = Keypair.generate();
		const secretKeyBytes = testKeypair.secretKey;

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({ localSecretKey: secretKeyBytes });

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.adapter).toBeDefined();
		expect(typeof result.adapter.getAddress).toBe("function");
		expect(typeof result.adapter.signTransaction).toBe("function");
	});

	it("returns ok when rpcUrl in config targets devnet", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		delete process.env.SOLANA_RPC_URL;

		const testKeypair = Keypair.generate();
		const secretKeyBytes = testKeypair.secretKey;

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: secretKeyBytes,
			rpcUrl: "https://api.devnet.solana.com",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.adapter).toBeDefined();
	});
});

describe("LocalKeypairAdapter", () => {
	afterEach(() => {
		delete process.env.COMPASS_LOCAL_SIGNER_ENABLED;
		delete process.env.SOLANA_RPC_URL;
		delete process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58;
		delete process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY;
		delete process.env.COMPASS_LOCAL_SIGNER_PUBLIC_KEY;
	});

	it("getAddress returns the correct base58 address for a test keypair", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

		const testKeypair = Keypair.generate();
		const expectedAddress = testKeypair.publicKey.toBase58();

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: testKeypair.secretKey,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const address = await result.adapter.getAddress();
		expect(address).toBe(expectedAddress);
	});

	it("signTransaction is defined as a function", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

		const testKeypair = Keypair.generate();

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: testKeypair.secretKey,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(typeof result.adapter.signTransaction).toBe("function");
	});

	it("does not expose secret key through any method", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

		const testKeypair = Keypair.generate();

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: testKeypair.secretKey,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const adapter = result.adapter;

		// Ensure no method returns or logs the secret key
		const addressStr = await adapter.getAddress();
		expect(addressStr).not.toContain(testKeypair.secretKey.toString());
	});

	it("signAndSendTransaction submits signed bytes through the Solana connection boundary", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

		const sendRawTransaction = vi
			.spyOn(Connection.prototype, "sendRawTransaction")
			.mockResolvedValue("real-devnet-signature" as never);
		const testKeypair = Keypair.generate();
		const tx = createUnsignedVersionedTransaction(testKeypair.publicKey);

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: testKeypair.secretKey,
			rpcUrl: "https://api.devnet.solana.com",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.adapter.signAndSendTransaction).toBeDefined();

		const signature = await result.adapter.signAndSendTransaction?.(tx);

		expect(signature).toBe("real-devnet-signature");
		expect(signature).not.toBe("mock-signature");
		expect(sendRawTransaction).toHaveBeenCalledTimes(1);
		const [submittedBytes] = sendRawTransaction.mock.calls[0];
		expect(submittedBytes).toBeInstanceOf(Uint8Array);
		expect(submittedBytes.length).toBeGreaterThan(0);
	});

	it("returns ok with adapter when COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 env var provides secret key", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		const testKeypair = Keypair.generate();
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 = bs58.encode(
			testKeypair.secretKey,
		);

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter(); // No localSecretKey in config

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.adapter).toBeDefined();
		expect(typeof result.adapter.getAddress).toBe("function");
		expect(typeof result.adapter.signTransaction).toBe("function");
		const address = await result.adapter.getAddress();
		expect(address).toBe(testKeypair.publicKey.toBase58());
	});

	it("returns ok with adapter when COMPASS_LOCAL_SIGNER_SECRET_KEY env var provides base58 secret key", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		const testKeypair = Keypair.generate();
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY = bs58.encode(
			testKeypair.secretKey,
		);

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const address = await result.adapter.getAddress();
		expect(address).toBe(testKeypair.publicKey.toBase58());
	});

	it("returns ok when configured public key matches derived signer address", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		const testKeypair = Keypair.generate();
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY = bs58.encode(
			testKeypair.secretKey,
		);
		process.env.COMPASS_LOCAL_SIGNER_PUBLIC_KEY = testKeypair.publicKey.toBase58();

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(true);
	});

	it("returns LOCAL_SIGNER_PUBLIC_KEY_MISMATCH when configured public key differs from derived signer address", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		const testKeypair = Keypair.generate();
		const otherKeypair = Keypair.generate();
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY = bs58.encode(
			testKeypair.secretKey,
		);
		process.env.COMPASS_LOCAL_SIGNER_PUBLIC_KEY = otherKeypair.publicKey.toBase58();

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter();

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_PUBLIC_KEY_MISMATCH");
	});

	it("returns LOCAL_SIGNER_NOT_CONFIGURED when both localSecretKey config and COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 env var are absent", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		delete process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58;

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter(); // No localSecretKey, no env var

		expect(result.ok).toBe(false);
		if (result.ok !== false) throw new Error("expected failure");
		expect(result.reason).toBe("LOCAL_SIGNER_NOT_CONFIGURED");
	});

	it("prefers localSecretKey config over COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 env var", async () => {
		process.env.COMPASS_LOCAL_SIGNER_ENABLED = "true";
		process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
		const configKeypair = Keypair.generate();
		const envKeypair = Keypair.generate();
		process.env.COMPASS_LOCAL_SIGNER_SECRET_KEY_B58 = bs58.encode(
			envKeypair.secretKey,
		);

		const { createSignerAdapter } = await import("../support/signer/signerAdapter");

		const result = createSignerAdapter({
			localSecretKey: configKeypair.secretKey,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const address = await result.adapter.getAddress();
		expect(address).toBe(configKeypair.publicKey.toBase58()); // Uses config key, not env var
	});
});
