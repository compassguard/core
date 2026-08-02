import { Keypair } from "@solana/web3.js";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";

import { MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA, type MagicBlockAuditProofRecord, type MagicBlockAuditProofRecordStore } from "@back/services/magicBlockAuditProofImportContracts";
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockAuditCommitment";
import type { MagicBlockFinalizedAuditProofVerifier } from "@back/services/magicBlockAuditProofVerificationContracts";

import { createMagicBlockAuditProofImportIngress } from "./magicBlockAuditProofImportIngress";
import { createMagicBlockAuditReadIngress } from "./magicBlockAuditReadIngress";
import { createPgMagicBlockAuditProofRecordStore } from "./magicBlockAuditProofRecordStorePg";

const NOW = "2026-08-01T12:00:00.000Z";
const SIGNER = Keypair.generate().publicKey.toBase58();
const DETAILS = {
	schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
	cluster: "devnet" as const,
	observationId: "obs_import_001",
	auditEventId: "aud_import_001",
	transactionDigest: "1".repeat(64), requestDigest: "2".repeat(64), resultDigest: "3".repeat(64),
	attestationDigest: "4".repeat(64), previousLedgerDigest: "5".repeat(64), ledgerDigest: "6".repeat(64),
	outcome: "review_required" as const,
};
const MATERIALIZED = materializeMagicBlockAuditCommitment(DETAILS);
const SIGNATURE = "7".repeat(64);
const PROOF = {
	schemaVersion: MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA,
	cluster: "devnet" as const,
	details: DETAILS,
	canonicalDetails: MATERIALIZED.canonicalDetails,
	commitmentDigest: MATERIALIZED.commitmentDigest,
	memo: MATERIALIZED.memo,
	signature: SIGNATURE,
};

describe("MagicBlock finalized audit proof import ingress", () => {
	it("is default-off and authenticates before parsing or dependencies", async () => {
		const disabled = createMagicBlockAuditProofImportIngress({ enabled: false });
		expect((await disabled.handle(request(PROOF, "secret"))).status).toBe(404);
		const verifier = vi.fn();
		const enabled = ingress(memoryStore(), verifier);
		expect((await enabled.handle(request(PROOF, null))).status).toBe(401);
		expect((await enabled.handle(request(PROOF, "wrong"))).status).toBe(401);
		expect(verifier).not.toHaveBeenCalled();
	});

	it("rejects oversized, malformed, open, wrong-cluster and rematerialization mismatches before verification", async () => {
		const verifier = vi.fn();
		const enabled = ingress(memoryStore(), verifier);
		const oversized = new Request("https://api.test/import", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json", "content-length": "9000" }, body: "{}" });
		expect((await enabled.handle(oversized)).status).toBe(400);
		for (const body of ["{", { ...PROOF, extra: true }, { ...PROOF, cluster: "mainnet-beta" }, { ...PROOF, commitmentDigest: "8".repeat(64) }, { ...PROOF, memo: `${PROOF.memo}x` }, { ...PROOF, signature: "bad" }]) {
			expect((await enabled.handle(request(body, "secret"))).status).toBe(400);
		}
		expect(verifier).not.toHaveBeenCalled();
	});

	it("requires JSON media type before body, RPC, or SQL", async () => {
		const store = memoryStore();
		const find = vi.spyOn(store, "findByAuditEventId");
		const verify = vi.fn();
		for (const contentType of [null, "text/plain", "application/cbor"]) {
			const response = await ingress(store, verify).handle(new Request("https://api.test/import", { method: "POST", headers: { authorization: "Bearer secret", ...(contentType ? { "content-type": contentType } : {}) }, body: JSON.stringify(PROOF) }));
			expect(response.status).toBe(415);
		}
		expect(find).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect((await ingress(memoryStore(), vi.fn(async () => confirmed())).handle(new Request("https://api.test/import", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(PROOF) }))).status).not.toBe(415);
	});

	it("settles a stalled authenticated request body at the deadline even when cancellation stalls", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		try {
			const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => { cancelled = true; return new Promise(() => undefined); } });
			const pending = ingress(memoryStore(), vi.fn()).handle(new Request("https://api.test/import", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
			await vi.advanceTimersByTimeAsync(5_001);
			const response = await pending;
			expect(response.status).toBe(400);
			expect(cancelled).toBe(true);
			expect(stream.locked).toBe(false);
		} finally { vi.useRealTimers(); }
	});

	it("persists a verified proof, reloads all identities, and exact replay returns the durable original without RPC", async () => {
		const store = memoryStore();
		const verify = vi.fn(async () => confirmed());
		const enabled = ingress(store, verify);
		const first = await enabled.handle(request(PROOF, "secret"));
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ replayed: false, record: { registration: { status: "confirmed", slot: 91 } } });
		const replay = await enabled.handle(request(PROOF, "secret"));
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ replayed: true });
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("rejects audit, observation, and signature identity conflicts", async () => {
		for (const mutation of [
			{ ...DETAILS, observationId: "obs_other" },
			{ ...DETAILS, auditEventId: "aud_other" },
			DETAILS,
		]) {
			const store = memoryStore();
			await store.save({ details: DETAILS, canonicalDetails: MATERIALIZED.canonicalDetails, registration: confirmed() });
			const nextMaterialized = materializeMagicBlockAuditCommitment(mutation);
			const signature = mutation === DETAILS ? "8".repeat(64) : SIGNATURE;
			const response = await ingress(store, vi.fn()).handle(request({ ...PROOF, details: mutation, canonicalDetails: nextMaterialized.canonicalDetails, commitmentDigest: nextMaterialized.commitmentDigest, memo: nextMaterialized.memo, signature }, "secret"));
			expect(response.status).toBe(409);
		}
	});

	it("recovers an acknowledged-as-failed committed save through exact retry", async () => {
		const store = memoryStore(true);
		const verify = vi.fn(async () => confirmed());
		const enabled = ingress(store, verify);
		const response = await enabled.handle(request(PROOF, "secret"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ replayed: false });
		expect((await enabled.handle(request(PROOF, "secret"))).status).toBe(200);
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("fails closed with sanitized output and never exposes verifier diagnostics", async () => {
		const secret = "Bearer do-not-return";
		const response = await ingress(memoryStore(), vi.fn(async () => ({ status: "retryable_failure", retryable: true, code: "ROUTER_UNAVAILABLE", routerDiagnostics: { rpcMethod: "getTransaction", message: secret } }))).handle(request(PROOF, "secret"));
		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain(secret);
	});

	it("rejects verifier signer, memo, digest, signature, and cluster mismatches without persistence", async () => {
		for (const registration of [
			{ ...confirmed(), signer: Keypair.generate().publicKey.toBase58() },
			{ ...confirmed(), memo: `${MATERIALIZED.memo}x` },
			{ ...confirmed(), commitmentDigest: "9".repeat(64) },
			{ ...confirmed(), signature: "8".repeat(64) },
			{ ...confirmed(), cluster: "mainnet-beta" as never },
		]) {
			const store = memoryStore();
			const response = await ingress(store, vi.fn(async () => registration)).handle(request(PROOF, "secret"));
			expect(response.status).toBe(503);
			expect(await store.findByAuditEventId(DETAILS.auditEventId)).toBeNull();
		}
	});

	it("serves durable fresh-request GET by audit ID and signature using only a public read-only verifier", async () => {
		const db = new PGlite();
		const sql = async (text: string, params: readonly unknown[] = []) => (await db.query(text, params as unknown[])).rows as Record<string, unknown>[];
		const store = createPgMagicBlockAuditProofRecordStore({ sql });
		const imported = await ingress(store, vi.fn(async () => confirmed())).handle(request(PROOF, "secret"));
		expect(imported.status).toBe(200);
		for (const query of [`auditId=${DETAILS.auditEventId}`, `signature=${SIGNATURE}`]) {
			const freshStore = createPgMagicBlockAuditProofRecordStore({ sql });
			const get = createMagicBlockAuditReadIngress({ enabled: true, apiKey: "secret", expectedSigner: SIGNER, auditRecords: freshStore, verifier: { verify: async () => confirmed() } });
			const response = await get.handle(new Request(`https://api.test/api/magicblock-devnet/audit?${query}`, { headers: { authorization: "Bearer secret" } }));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ details: { auditEventId: DETAILS.auditEventId }, registration: { signature: SIGNATURE } });
		}
		await db.close();
	});

	it("upgrades a legacy audit table before import and serves fresh durable lookups", async () => {
		const db = new PGlite();
		const sql = async (text: string, params: readonly unknown[] = []) => (await db.query(text, params as unknown[])).rows as Record<string, unknown>[];
		await sql(`CREATE TABLE magicblock_devnet_onchain_audit (
			audit_event_id text PRIMARY KEY,
			signature text UNIQUE,
			commitment_digest text NOT NULL,
			canonical_details text NOT NULL,
			registration jsonb NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now()
		)`);
		const imported = await ingress(createPgMagicBlockAuditProofRecordStore({ sql }), vi.fn(async () => confirmed())).handle(request(PROOF, "secret"));
		expect(imported.status).toBe(200);
		const freshStore = createPgMagicBlockAuditProofRecordStore({ sql });
		for (const record of await Promise.all([
			freshStore.findByAuditEventId(DETAILS.auditEventId),
			freshStore.findByObservationId(DETAILS.observationId),
			freshStore.findBySignature(SIGNATURE),
		])) expect(record).toMatchObject({ details: { auditEventId: DETAILS.auditEventId, observationId: DETAILS.observationId }, registration: { signature: SIGNATURE } });
		await db.close();
	});

	it("recovers a committed PostgreSQL write with a lost acknowledgement and fresh exact retry", async () => {
		const db = new PGlite();
		const sql = async (text: string, params: readonly unknown[] = []) => (await db.query(text, params as unknown[])).rows as Record<string, unknown>[];
		const durable = createPgMagicBlockAuditProofRecordStore({ sql });
		let first = true;
		const lostAckStore: MagicBlockAuditProofRecordStore = {
			...durable,
			async save(record) { await durable.save(record); if (first) { first = false; throw new Error("lost acknowledgement"); } },
		};
		const verify = vi.fn(async () => confirmed());
		expect((await ingress(lostAckStore, verify).handle(request(PROOF, "secret"))).status).toBe(200);
		const freshVerify = vi.fn();
		const fresh = ingress(createPgMagicBlockAuditProofRecordStore({ sql }), freshVerify);
		const replay = await fresh.handle(request(PROOF, "secret"));
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ replayed: true, record: { registration: { signature: SIGNATURE } } });
		expect(freshVerify).not.toHaveBeenCalled();
		await db.close();
	});
});

function confirmed() {
	return { status: "confirmed" as const, cluster: "devnet" as const, routerUrl: "https://devnet-router.magicblock.app/" as const, signature: SIGNATURE, signer: SIGNER, slot: 91, commitmentDigest: MATERIALIZED.commitmentDigest, memo: MATERIALIZED.memo, verifiedAt: NOW };
}

function request(body: unknown, bearer: string | null) {
	return new Request("https://api.test/api/magicblock-devnet/audit/import", { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function ingress(store: MagicBlockAuditProofRecordStore, verify: ReturnType<typeof vi.fn>) {
	return createMagicBlockAuditProofImportIngress({ enabled: true, apiKey: "secret", runtime: { expectedSigner: SIGNER, auditRecords: store, verifier: { verify: verify as MagicBlockFinalizedAuditProofVerifier["verify"] } } });
}

function memoryStore(throwAfterFirstSave = false): MagicBlockAuditProofRecordStore {
	let records: MagicBlockAuditProofRecord[] = [];
	let throws = throwAfterFirstSave;
	return {
		async save(record) { records = [...records.filter((item) => item.details.auditEventId !== record.details.auditEventId), structuredClone(record)]; if (throws) { throws = false; throw new Error("lost acknowledgement"); } },
		async findByAuditEventId(id) { return records.find((item) => item.details.auditEventId === id) ?? null; },
		async findByObservationId(id) { return records.find((item) => item.details.observationId === id) ?? null; },
		async findBySignature(signature) { return records.find((item) => "signature" in item.registration && item.registration.signature === signature) ?? null; },
	};
}
