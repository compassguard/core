import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { canonicalJson, sha256Hex } from "@back/services/magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
	MAGICBLOCK_OBSERVATION_SCHEMA,
	type MagicBlockDevnetObservationResultV1,
	type MagicBlockObservationStore,
} from "@back/services/magicBlockDevnetObservationContracts";
import type {
	MagicBlockAppendOnlyAuditLedger,
	MagicBlockPost,
} from "@back/services/magicBlockDevnetPreflightTypes";
import {
	materializeMagicBlockAuditCommitment,
} from "@back/services/magicBlockOnchainAudit";
import type {
	MagicBlockAuditRecord,
	MagicBlockAuditRecordStore,
	MagicBlockOnchainAuditSubmitter,
} from "@back/services/magicBlockOnchainAuditContracts";

import type { SqlExecutor } from "../verdict/verdictStorePg";
import { createMagicBlockAuditIngress } from "./magicBlockAuditIngress";
import { createPgMagicBlockAppendOnlyAuditLedger } from "./magicBlockAuditLedgerPg";
import { createPgMagicBlockAuditRecordStore } from "./magicBlockAuditRecordStorePg";
import { createPgMagicBlockObservationStore } from "./magicBlockObservationStorePg";

const NOW = "2026-07-28T12:00:00.000Z";

describe("MagicBlock authenticated audit ingress", () => {
	it("is disabled by default and does no work", async () => {
		const ingress = createMagicBlockAuditIngress({ enabled: false });
		const response = await ingress.handle(observationRequest());

		expect(response.status).toBe(404);
	});

	it("requires its dedicated bearer before parsing or dispatching", async () => {
		const observations = createMemoryObservationStore();
		const post = vi.fn<
			Parameters<MagicBlockPost>,
			ReturnType<MagicBlockPost>
		>();
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
				runtime: {
					observations,
					createLedger: createMemoryLedgerFactory(observations),
					post,
					now: () => NOW,
			},
		});

		const response = await ingress.handle(observationRequest(null));
		expect(response.status).toBe(401);
		expect(post).not.toHaveBeenCalled();
		expect(observations.claimCount()).toBe(0);
	});

	it("reconciles a prepared signature through GET before returning success", async () => {
		const details = {
			schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
			cluster: "devnet" as const,
			observationId: "obs-query",
			auditEventId: "aud_query",
			transactionDigest: "1".repeat(64),
			requestDigest: "2".repeat(64),
			resultDigest: "3".repeat(64),
			attestationDigest: "4".repeat(64),
			previousLedgerDigest: "5".repeat(64),
			ledgerDigest: "6".repeat(64),
			outcome: "review_required" as const,
		};
		const commitment = materializeMagicBlockAuditCommitment(details);
		let record: MagicBlockAuditRecord = {
			details,
			canonicalDetails: commitment.canonicalDetails,
			registration: {
				status: "retryable_failure",
				retryable: true,
				code: "SUBMISSION_UNCONFIRMED",
				signature: "3".repeat(64),
				commitmentDigest: commitment.commitmentDigest,
				memo: commitment.memo,
			},
		};
		const proof = {
			status: "confirmed" as const,
			cluster: "devnet" as const,
			routerUrl: "https://devnet-router.magicblock.app/" as const,
			signature: "3".repeat(64),
			signer: "11111111111111111111111111111111",
			slot: 77,
			commitmentDigest: commitment.commitmentDigest,
			memo: commitment.memo,
			verifiedAt: NOW,
		};
		const verify = vi.fn(async () => proof);
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
			runtime: {
				observations: createMemoryObservationStore(),
				createLedger: createMemoryLedgerFactory(
					createMemoryObservationStore(),
				),
				post: boundDelegationPost("delegated"),
				auditRecords: {
					async save(next) {
						record = next;
					},
					async reservePrepared({ record: next }) {
						record = next;
						return next;
					},
					async findByAuditEventId() {
						return record;
					},
					async findByObservationId() {
						return record;
					},
					async findBySignature() {
						return record;
					},
				},
				onchainAudit: {
					async register() {
						throw new Error("not used");
					},
					verify,
				},
			},
		});
		const response = await ingress.handle(
			new Request(
				`https://api.compassguard.xyz/api/magicblock-devnet/audit?signature=${"3".repeat(64)}`,
				{
				headers: { Authorization: "Bearer audit-secret" },
				},
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			registration: { status: "confirmed", slot: 77 },
		});
		expect(verify).toHaveBeenCalledWith({
			signature: "3".repeat(64),
			expectedCommitmentDigest: commitment.commitmentDigest,
			expectedMemo: commitment.memo,
		});
	});

	it("persists prepared-to-confirmed GET reconciliation in Postgres", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql });
		const records = createPgMagicBlockAuditRecordStore({ sql });
		const requestDigest = "2".repeat(64);
		const claim = await observations.claim(
			claimInput("obs-query-pg", requestDigest, NOW),
		);
		const details = {
			schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
			cluster: "devnet" as const,
			observationId: "obs-query-pg",
			auditEventId: "aud_query_pg",
			transactionDigest: "1".repeat(64),
			requestDigest,
			resultDigest: "3".repeat(64),
			attestationDigest: "4".repeat(64),
			previousLedgerDigest: "5".repeat(64),
			ledgerDigest: "6".repeat(64),
			outcome: "review_required" as const,
		};
		const commitment = materializeMagicBlockAuditCommitment(details);
		await records.reservePrepared({
			record: {
				details,
				canonicalDetails: commitment.canonicalDetails,
				registration: {
					status: "retryable_failure",
					retryable: true,
					code: "SUBMISSION_UNCONFIRMED",
					signature: "4".repeat(64),
					commitmentDigest: commitment.commitmentDigest,
					memo: commitment.memo,
				},
			},
			requestDigest,
			claimAttempt: claimedAttempt(claim),
		});
		const proof = {
			status: "confirmed" as const,
			cluster: "devnet" as const,
			routerUrl: "https://devnet-router.magicblock.app/" as const,
			signature: "4".repeat(64),
			signer: "11111111111111111111111111111111",
			slot: 88,
			commitmentDigest: commitment.commitmentDigest,
			memo: commitment.memo,
			verifiedAt: NOW,
		};
		let verificationAttempts = 0;
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
			runtime: {
				observations,
				createLedger: createMemoryLedgerFactory(observations),
				post: boundDelegationPost("delegated"),
				auditRecords: records,
				onchainAudit: {
					async register() {
						throw new Error("not used");
					},
					async verify() {
						verificationAttempts += 1;
						return verificationAttempts === 1
							? {
									status: "retryable_failure" as const,
									retryable: true as const,
									code: "ROUTER_UNAVAILABLE" as const,
							  }
							: proof;
					},
				},
			},
		});
		const request = () =>
			new Request(
				`https://api.compassguard.xyz/api/magicblock-devnet/audit?auditId=${details.auditEventId}`,
				{ headers: { Authorization: "Bearer audit-secret" } },
			);
		const retryable = await ingress.handle(request());
		expect(retryable.status).toBe(503);
		await expect(
			records.findByAuditEventId(details.auditEventId),
		).resolves.toMatchObject({
			registration: {
				status: "retryable_failure",
				signature: "4".repeat(64),
				commitmentDigest: commitment.commitmentDigest,
				memo: commitment.memo,
			},
		});
		const response = await ingress.handle(request());
		expect(response.status).toBe(200);
		await expect(
			records.findByAuditEventId(details.auditEventId),
		).resolves.toMatchObject({
			registration: { status: "confirmed", slot: 88 },
		});
	});

	it("persists only closed sanitized Router diagnostics", async () => {
		const db = new PGlite();
		const records = createPgMagicBlockAuditRecordStore({
			sql: executor(db),
		});
		const details = {
			schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
			cluster: "devnet" as const,
			observationId: "obs-router-diagnostics",
			auditEventId: "aud_router_diagnostics",
			transactionDigest: "1".repeat(64),
			requestDigest: "2".repeat(64),
			resultDigest: "3".repeat(64),
			attestationDigest: "4".repeat(64),
			previousLedgerDigest: "5".repeat(64),
			ledgerDigest: "6".repeat(64),
			outcome: "review_required" as const,
		};
		const commitment = materializeMagicBlockAuditCommitment(details);
		const record: MagicBlockAuditRecord = {
			details,
			canonicalDetails: commitment.canonicalDetails,
			registration: {
				status: "retryable_failure",
				retryable: true,
				code: "ROUTER_PREFLIGHT_REJECTED",
				routerDiagnostics: {
					rpcMethod: "sendTransaction",
					httpStatus: 200,
					rpcErrorCode: -32002,
					message: "Transaction simulation failed: Blockhash not found",
					requestId: "router-request-123",
				},
			},
		};

		await records.save(record);
		await expect(
			records.findByAuditEventId(details.auditEventId),
		).resolves.toEqual(record);
		await expect(
			records.save({
				...record,
				registration: {
					...record.registration,
					routerDiagnostics: {
						...(record.registration.status === "retryable_failure"
							? record.registration.routerDiagnostics
							: {}),
						rawRequestBody: "forbidden",
					},
				},
			} as unknown as MagicBlockAuditRecord),
		).rejects.toThrow("audit record unavailable");
	});

	it("decodes, observes, appends once, and returns the cached idempotent result", async () => {
		const observations = createMemoryObservationStore();
		const createLedger = createMemoryLedgerFactory(observations);
		const post = boundDelegationPost("delegated");
		let id = 0;
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
				runtime: {
					observations,
					createLedger,
					post,
					now: () => NOW,
					createOpaqueId: (kind) => `${kind}-${++id}`,
					...confirmedOnchainRuntime(),
			},
		});

		const first = await ingress.handle(observationRequest("audit-secret"));
		const firstBody = (await first.json()) as MagicBlockDevnetObservationResultV1;
		expect(first.status, JSON.stringify(firstBody)).toBe(200);
		expect(firstBody).toMatchObject({
			schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
			observationId: "observation-1",
			outcome: "review_required",
			audit: { auditEventId: "aud_test_1" },
		});
		expect(post).toHaveBeenCalledTimes(2);

		const replay = await ingress.handle(observationRequest("audit-secret"));
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(firstBody);
		expect(post).toHaveBeenCalledTimes(2);
	});

	it("fails closed and persists unavailable without exposing provider errors", async () => {
		const observations = createMemoryObservationStore();
		const post: MagicBlockPost = vi.fn(async () => {
			throw new Error("private provider detail");
		});
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
				runtime: {
					observations,
					createLedger: createMemoryLedgerFactory(observations),
				post,
				now: () => NOW,
			},
		});

		const response = await ingress.handle(observationRequest("audit-secret"));
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toEqual({
			schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
			observationId: "observation-1",
			outcome: "unavailable",
		});
		expect(JSON.stringify(body)).not.toContain("private provider detail");
	});

	it("does not claim success when the durable append result is indeterminate", async () => {
		const observations = createMemoryObservationStore();
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
			runtime: {
				observations,
				createLedger: createMemoryLedgerFactory(observations, {
					throwAfterComplete: true,
				}),
				post: boundDelegationPost("delegated"),
				now: () => NOW,
				...confirmedOnchainRuntime(),
			},
		});

		const response = await ingress.handle(observationRequest());
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ outcome: "unavailable" });
	});

	it("bounds eight delayed account observations to two batches of four within the route budget", async () => {
		const observations = createMemoryObservationStore();
		const respond = boundDelegationPost("delegated");
		let active = 0;
		let maximumActive = 0;
		const delayedPost: MagicBlockPost = vi.fn(async (request) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			try {
				return await respond(request);
			} finally {
				active -= 1;
			}
		});
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
			runtime: {
				observations,
				createLedger: createMemoryLedgerFactory(observations),
				post: delayedPost,
				now: () => NOW,
				...confirmedOnchainRuntime(),
			},
		});

		const startedAt = Date.now();
		const response = await ingress.handle(
			observationRequest("audit-secret", {
				observationId: "observation-eight",
				accountCount: 8,
			}),
		);
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		expect((await response.json()).outcome).toBe("review_required");
		expect(delayedPost).toHaveBeenCalledTimes(8);
		expect(maximumActive).toBe(4);
		expect(elapsedMs).toBeLessThan(500);
	});

	it("rejects a ninth account before any provider dispatch", async () => {
		const observations = createMemoryObservationStore();
		const post = boundDelegationPost("delegated");
		const ingress = createMagicBlockAuditIngress({
			enabled: true,
			apiKey: "audit-secret",
			runtime: {
				observations,
				createLedger: createMemoryLedgerFactory(observations),
				post,
				now: () => NOW,
			},
		});

		const response = await ingress.handle(
			observationRequest("audit-secret", {
				observationId: "observation-nine",
				accountCount: 9,
			}),
		);

		expect(await response.json()).toMatchObject({ outcome: "unavailable" });
		expect(post).not.toHaveBeenCalled();
	});
});

describe("MagicBlock Postgres persistence", () => {
	it("claims an observation once, returns its completed result, and rejects digest reuse", async () => {
		const db = new PGlite();
		const store = createPgMagicBlockObservationStore({ sql: executor(db) });
		const requestDigest = "a".repeat(64);
		const result: MagicBlockDevnetObservationResultV1 = {
			schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
			observationId: "obs-pg",
			outcome: "unavailable",
		};

		await expect(
			store.claim(claimInput("obs-pg", requestDigest, NOW)),
		).resolves.toEqual({ status: "claimed", claimAttempt: 1 });
		await expect(
			store.claim(claimInput("obs-pg", requestDigest, NOW)),
		).resolves.toEqual({ status: "pending" });
		await store.complete({
			observationId: "obs-pg",
			requestDigest,
			claimAttempt: 1,
			result,
			completedAt: NOW,
		});
		await expect(
			store.claim(claimInput("obs-pg", requestDigest, NOW)),
		).resolves.toEqual({ status: "completed", result });
		await expect(
				store.claim(claimInput("obs-pg", "b".repeat(64), NOW)),
		).resolves.toEqual({ status: "conflict" });
	});

	it("recovers a stale pending claim exactly once while an active lease remains pending", async () => {
		const db = new PGlite();
		const store = createPgMagicBlockObservationStore({ sql: executor(db) });
		const requestDigest = "c".repeat(64);
		const firstAt = "2026-07-28T12:00:00.000Z";
		const activeRetryAt = "2026-07-28T12:00:05.000Z";
		const staleRetryAt = "2026-07-28T12:00:13.000Z";

		await expect(
			store.claim(claimInput("obs-stale", requestDigest, firstAt)),
		).resolves.toEqual({ status: "claimed", claimAttempt: 1 });
		await expect(
			store.claim(claimInput("obs-stale", requestDigest, activeRetryAt)),
		).resolves.toEqual({ status: "pending" });
		await expect(
			store.claim(claimInput("obs-stale", requestDigest, staleRetryAt)),
		).resolves.toEqual({ status: "claimed", claimAttempt: 2 });
		await expect(
			store.claim(claimInput("obs-stale", requestDigest, staleRetryAt)),
		).resolves.toEqual({ status: "pending" });
	});

	it("allows only the current claim attempt to reserve the send signature", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql });
		const records = createPgMagicBlockAuditRecordStore({ sql });
		const requestDigest = "e".repeat(64);
		const first = await observations.claim(
			claimInput("obs-reserve", requestDigest, "2026-07-28T12:00:00.000Z"),
		);
		const current = await observations.claim(
			claimInput("obs-reserve", requestDigest, "2026-07-28T12:00:13.000Z"),
		);
		const details = {
			schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
			cluster: "devnet" as const,
			observationId: "obs-reserve",
			auditEventId: "aud_reserve",
			transactionDigest: "1".repeat(64),
			requestDigest,
			resultDigest: "2".repeat(64),
			attestationDigest: "3".repeat(64),
			previousLedgerDigest: "4".repeat(64),
			ledgerDigest: "5".repeat(64),
			outcome: "review_required" as const,
		};
		const commitment = materializeMagicBlockAuditCommitment(details);
		const prepared = (signature: string): MagicBlockAuditRecord => ({
			details,
			canonicalDetails: commitment.canonicalDetails,
			registration: {
				status: "retryable_failure",
				retryable: true,
				code: "SUBMISSION_UNCONFIRMED",
				signature,
				commitmentDigest: commitment.commitmentDigest,
				memo: commitment.memo,
			},
		});
		await expect(
			records.reservePrepared({
				record: prepared("2".repeat(64)),
				requestDigest,
				claimAttempt: claimedAttempt(first),
			}),
		).rejects.toThrow("reservation");
		await expect(
			records.reservePrepared({
				record: prepared("3".repeat(64)),
				requestDigest,
				claimAttempt: claimedAttempt(current),
			}),
		).resolves.toMatchObject({
			registration: { signature: "3".repeat(64) },
		});
		await expect(
			records.reservePrepared({
				record: prepared("4".repeat(64)),
				requestDigest,
				claimAttempt: claimedAttempt(current),
			}),
		).resolves.toMatchObject({
			registration: { signature: "3".repeat(64) },
		});
	});

	it("fences stale claimants from both audit and unavailable finalization", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql });
		const requestDigest = "e".repeat(64);
		const firstClaim = await observations.claim(
			claimInput("obs-fenced", requestDigest, "2026-07-28T12:00:00.000Z"),
		);
		const secondClaim = await observations.claim(
			claimInput("obs-fenced", requestDigest, "2026-07-28T12:00:13.000Z"),
		);
		expect(firstClaim).toEqual({ status: "claimed", claimAttempt: 1 });
		expect(secondClaim).toEqual({ status: "claimed", claimAttempt: 2 });

		const staleLedger = createPgMagicBlockAppendOnlyAuditLedger({
			sql,
			observationId: "obs-fenced",
			requestDigest,
			claimAttempt: claimedAttempt(firstClaim),
			createAuditEventId: () => "aud_pg_stale",
			now: () => NOW,
		});
		await expect(
			staleLedger.appendAtomic(appendInput("candidate-stale")),
		).rejects.toThrow();
		await expect(
			observations.complete({
				observationId: "obs-fenced",
				requestDigest,
				claimAttempt: claimedAttempt(firstClaim),
				result: {
					schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
					observationId: "obs-fenced",
					outcome: "unavailable",
				},
				completedAt: NOW,
			}),
		).rejects.toThrow("observation unavailable");

		const pending = await sql(
			`SELECT status, claim_attempts, result
			FROM magicblock_devnet_observations WHERE observation_id = $1`,
			["obs-fenced"],
		);
		expect(pending).toEqual([
			{ status: "pending", claim_attempts: 2, result: null },
		]);
		expect(
			await sql(
				`SELECT audit_event_id FROM magicblock_devnet_audit_ledger
				WHERE observation_id = $1`,
				["obs-fenced"],
			),
		).toHaveLength(0);

		const currentLedger = createPgMagicBlockAppendOnlyAuditLedger({
			sql,
			observationId: "obs-fenced",
			requestDigest,
			claimAttempt: claimedAttempt(secondClaim),
			createAuditEventId: () => "aud_pg_current",
			now: () => NOW,
		});
		const currentAudit = await currentLedger.appendAtomic(
			appendInput("candidate-current"),
		);
		expect(currentAudit).toMatchObject({ auditEventId: "aud_pg_current" });
		await expect(
			currentLedger.appendAtomic(appendInput("candidate-current")),
		).resolves.toMatchObject({ auditEventId: "aud_pg_current", reused: true });
		await observations.complete({
			observationId: "obs-fenced",
			requestDigest,
			claimAttempt: claimedAttempt(secondClaim),
			result: auditResult("obs-fenced", currentAudit),
			completedAt: NOW,
		});

		const completed = await observations.claim(
			claimInput("obs-fenced", requestDigest, NOW),
		);
		expect(completed).toMatchObject({
			status: "completed",
			result: {
				outcome: "review_required",
				audit: { auditEventId: "aud_pg_current" },
			},
		});
		expect(
			await sql(
				`SELECT audit_event_id FROM magicblock_devnet_audit_ledger
				WHERE observation_id = $1`,
				["obs-fenced"],
			),
		).toEqual([{ audit_event_id: "aud_pg_current" }]);
	});

	it("rolls back completion when the singleton tip is missing and retries after restoration", async () => {
		const db = new PGlite();
		const baseSql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql: baseSql });
		const requestDigest = "f".repeat(64);
		const claim = await observations.claim(
			claimInput("obs-missing-tip", requestDigest, NOW),
		);
		let removeTipBeforeAppend = true;
		const missingTipSql: SqlExecutor = async (text, params) => {
			if (removeTipBeforeAppend && text.includes("WITH locked_observation")) {
				removeTipBeforeAppend = false;
				await baseSql(`DELETE FROM magicblock_devnet_audit_tip`, []);
			}
			return baseSql(text, params);
		};
		const ledger = createPgMagicBlockAppendOnlyAuditLedger({
			sql: missingTipSql,
			observationId: "obs-missing-tip",
			requestDigest,
			claimAttempt: claimedAttempt(claim),
			createAuditEventId: () => "aud_pg_restored",
			now: () => NOW,
		});

		await expect(
			ledger.appendAtomic(appendInput("candidate-restored")),
		).rejects.toThrow();
		expect(
			await baseSql(
				`SELECT status, result FROM magicblock_devnet_observations
				WHERE observation_id = $1`,
				["obs-missing-tip"],
			),
		).toEqual([{ status: "pending", result: null }]);
		expect(
			await baseSql(
				`SELECT audit_event_id FROM magicblock_devnet_audit_ledger
				WHERE observation_id = $1`,
				["obs-missing-tip"],
			),
		).toHaveLength(0);

		await baseSql(
			`INSERT INTO magicblock_devnet_audit_tip
				(singleton, sequence, previous_event_digest, ledger_event_digest)
			VALUES (true, 0, NULL, NULL)`,
			[],
		);
		const restoredAudit = await ledger.appendAtomic(
			appendInput("candidate-restored"),
		);
		expect(restoredAudit).toMatchObject({ auditEventId: "aud_pg_restored" });
		expect(
			await baseSql(
				`SELECT status FROM magicblock_devnet_observations
				WHERE observation_id = $1`,
				["obs-missing-tip"],
			),
		).toEqual([{ status: "pending" }]);
		await observations.complete({
			observationId: "obs-missing-tip",
			requestDigest,
			claimAttempt: claimedAttempt(claim),
			result: auditResult("obs-missing-tip", restoredAudit),
			completedAt: NOW,
		});
		expect(
			await baseSql(
				`SELECT audit_event_id FROM magicblock_devnet_audit_ledger
				WHERE observation_id = $1`,
				["obs-missing-tip"],
			),
		).toEqual([{ audit_event_id: "aud_pg_restored" }]);
	});

	it("serializes concurrent appends into one durable SHA-256 chain and completes both observations atomically", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql });
		const digestA = "a".repeat(64);
		const digestB = "b".repeat(64);
		const claimA = await observations.claim(claimInput("obs-a", digestA, NOW));
		const claimB = await observations.claim(claimInput("obs-b", digestB, NOW));
		const ledgerA = createPgMagicBlockAppendOnlyAuditLedger({
			sql,
			observationId: "obs-a",
			requestDigest: digestA,
			claimAttempt: claimedAttempt(claimA),
			createAuditEventId: () => "aud_pg_1",
			now: () => NOW,
		});
		const ledgerB = createPgMagicBlockAppendOnlyAuditLedger({
			sql,
			observationId: "obs-b",
			requestDigest: digestB,
			claimAttempt: claimedAttempt(claimB),
			createAuditEventId: () => "aud_pg_2",
			now: () => NOW,
		});

		const [auditA, auditB] = await Promise.all([
			ledgerA.appendAtomic(appendInput("candidate-a")),
			ledgerB.appendAtomic(appendInput("candidate-b")),
		]);
		const rows = await sql(
			`SELECT sequence, audit_event_id, previous_event_digest, ledger_event_digest
			FROM magicblock_devnet_audit_ledger ORDER BY sequence ASC`,
			[],
		);

		expect(rows).toHaveLength(2);
		expect(rows[0]?.previous_event_digest).toBeNull();
		expect(rows[1]?.previous_event_digest).toBe(rows[0]?.ledger_event_digest);
		expect(rows[0]?.ledger_event_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[1]?.ledger_event_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2]);
		await observations.complete({
			observationId: "obs-a",
			requestDigest: digestA,
			claimAttempt: claimedAttempt(claimA),
			result: auditResult("obs-a", auditA),
			completedAt: NOW,
		});
		await observations.complete({
			observationId: "obs-b",
			requestDigest: digestB,
			claimAttempt: claimedAttempt(claimB),
			result: auditResult("obs-b", auditB),
			completedAt: NOW,
		});
		await expect(
			observations.claim(claimInput("obs-a", digestA, NOW)),
		).resolves.toMatchObject({ status: "completed" });
		await expect(
			observations.claim(claimInput("obs-b", digestB, NOW)),
		).resolves.toMatchObject({ status: "completed" });
	});

	it("reconciles a lost SQL response after commit from the completed observation row", async () => {
		const db = new PGlite();
		const baseSql = executor(db);
		const observations = createPgMagicBlockObservationStore({ sql: baseSql });
		const requestDigest = "d".repeat(64);
		const claim = await observations.claim(
			claimInput("obs-ambiguous", requestDigest, NOW),
		);
		let loseAppendResponse = true;
		const ambiguousSql: SqlExecutor = async (text, params) => {
			const rows = await baseSql(text, params);
			if (loseAppendResponse && text.includes("WITH locked_observation")) {
				loseAppendResponse = false;
				throw new Error("simulated response loss after commit");
			}
			return rows;
		};
		const ledger = createPgMagicBlockAppendOnlyAuditLedger({
			sql: ambiguousSql,
			observationId: "obs-ambiguous",
			requestDigest,
			claimAttempt: claimedAttempt(claim),
			createAuditEventId: () => "aud_pg_ambiguous",
			now: () => NOW,
		});

		await expect(
			ledger.appendAtomic(appendInput("candidate-ambiguous")),
		).rejects.toThrow("simulated response loss after commit");
		const recoveredAudit = await ledger.appendAtomic(
			appendInput("candidate-ambiguous"),
		);
		await observations.complete({
			observationId: "obs-ambiguous",
			requestDigest,
			claimAttempt: claimedAttempt(claim),
			result: auditResult("obs-ambiguous", recoveredAudit),
			completedAt: NOW,
		});
		const reconciled = await observations.claim(claimInput("obs-ambiguous", requestDigest, NOW));
		expect(reconciled).toMatchObject({
			status: "completed",
			result: {
				outcome: "review_required",
				audit: { auditEventId: "aud_pg_ambiguous" },
			},
		});
		const rows = await baseSql(
			`SELECT observation_id FROM magicblock_devnet_audit_ledger
			WHERE observation_id = $1`,
			["obs-ambiguous"],
		);
		expect(rows).toHaveLength(1);
	});
});

function observationRequest(
	apiKey: string | null = "audit-secret",
	options: {
		readonly observationId?: string;
		readonly accountCount?: number;
	} = {},
): Request {
	return new Request("https://api.compassguard.xyz/api/magicblock-devnet/audit", {
		method: "POST",
		headers: {
			...(apiKey === null ? {} : { Authorization: `Bearer ${apiKey}` }),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
			observationId: options.observationId ?? "observation-1",
			unsignedTransactionBase64: unsignedV0Transaction(
				options.accountCount ?? 2,
			),
		}),
	});
}

function unsignedV0Transaction(accountCount: number): string {
	return Buffer.from([
		1,
		...Array.from({ length: 64 }, () => 0),
		0x80,
		1,
		0,
		1,
		accountCount,
		...Array.from({ length: accountCount }, (_, accountIndex) =>
			Array.from({ length: 32 }, () => accountIndex + 1),
		).flat(),
		...Array.from({ length: 32 }, () => 7),
		1,
		accountCount - 1,
		accountCount - 1,
		...Array.from({ length: accountCount - 1 }, (_, index) => index),
		0,
		0,
	]).toString("base64");
}

function boundDelegationPost(status: "delegated" | "base_layer"): MagicBlockPost {
	return vi.fn(async (request) => {
		const body = JSON.parse(request.body) as {
			id: number;
			params: [string];
		};
		expect(body.params).toHaveLength(1);
		expect(typeof body.params[0]).toBe("string");
		return {
			status: 200,
			url: request.url,
			redirected: false,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					isDelegated: status === "delegated",
				},
			}),
		};
	});
}

function createMemoryObservationStore(): MagicBlockObservationStore & {
	claimCount(): number;
} {
	const records = new Map<
		string,
		{
			digest: string;
			claimAttempt: number;
			result?: MagicBlockDevnetObservationResultV1;
		}
	>();
	let claims = 0;
	return {
		claimCount: () => claims,
		async claim(input) {
			claims += 1;
			const existing = records.get(input.observationId);
			if (!existing) {
				records.set(input.observationId, {
					digest: input.requestDigest,
					claimAttempt: 1,
				});
				return { status: "claimed", claimAttempt: 1 };
			}
			if (existing.digest !== input.requestDigest) return { status: "conflict" };
			return existing.result
				? { status: "completed", result: existing.result }
				: { status: "pending" };
		},
		async complete(input) {
			const existing = records.get(input.observationId);
			if (
				!existing ||
				existing.digest !== input.requestDigest ||
				existing.claimAttempt !== input.claimAttempt
			) {
				throw new Error("conflict");
			}
			existing.result = input.result;
		},
	};
}

function createMemoryLedgerFactory(
	_observations: MagicBlockObservationStore,
	options: { readonly throwAfterComplete?: boolean } = {},
) {
	let sequence = 0;
	return (): MagicBlockAppendOnlyAuditLedger => ({
		async appendAtomic(input) {
			const event = input.materialize(`aud_test_${++sequence}`);
			if (options.throwAfterComplete) throw new Error("indeterminate commit");
			return {
				auditEventId: event.payload.auditEventId,
				attestationDigest: event.attestationDigest,
				previousLedgerDigest: "0".repeat(64),
				ledgerDigest: sha256Hex("ledger", event.canonicalPayload),
				canonicalPayload: event.canonicalPayload,
			};
		},
	});
}

function confirmedOnchainRuntime(): {
	readonly auditRecords: MagicBlockAuditRecordStore;
	readonly onchainAudit: MagicBlockOnchainAuditSubmitter;
} {
	const records = new Map<string, MagicBlockAuditRecord>();
	const auditRecords: MagicBlockAuditRecordStore = {
		async save(record) {
			records.set(record.details.auditEventId, record);
		},
		async reservePrepared({ record }) {
			const existing = records.get(record.details.auditEventId);
			if (existing) return existing;
			records.set(record.details.auditEventId, record);
			return record;
		},
		async findByAuditEventId(auditEventId) {
			return records.get(auditEventId) ?? null;
		},
		async findByObservationId(observationId) {
			return (
				[...records.values()].find(
					(record) => record.details.observationId === observationId,
				) ?? null
			);
		},
		async findBySignature(signature) {
			return (
				[...records.values()].find(
					(record) =>
						"signature" in record.registration &&
						record.registration.signature === signature,
				) ?? null
			);
		},
	};
	const proof = (details: MagicBlockAuditRecord["details"]) => {
		const commitment = materializeMagicBlockAuditCommitment(details);
		return {
			status: "confirmed" as const,
			cluster: "devnet" as const,
			routerUrl: "https://devnet-router.magicblock.app/" as const,
			signature: "2".repeat(64),
			signer: "11111111111111111111111111111111",
			slot: 123,
			commitmentDigest: commitment.commitmentDigest,
			memo: commitment.memo,
			verifiedAt: NOW,
		};
	};
	const onchainAudit: MagicBlockOnchainAuditSubmitter = {
		async register(details, onPrepared) {
			const commitment = materializeMagicBlockAuditCommitment(details);
			const prepared = {
				status: "retryable_failure" as const,
				retryable: true as const,
				code: "SUBMISSION_UNCONFIRMED" as const,
				signature: "2".repeat(64),
				commitmentDigest: commitment.commitmentDigest,
				memo: commitment.memo,
			};
			await onPrepared?.(prepared);
			return proof(details);
		},
		async verify({ signature }) {
			const record = await auditRecords.findBySignature(signature);
			if (!record) {
				return {
					status: "retryable_failure",
					retryable: true,
					code: "TRANSACTION_VERIFICATION_FAILED",
				};
			}
			return proof(record.details);
		},
	};
	return { auditRecords, onchainAudit };
}

function claimInput(
	observationId: string,
	requestDigest: string,
	receivedAt: string,
) {
	return {
		observationId,
		requestDigest,
		receivedAt,
		staleBefore: new Date(Date.parse(receivedAt) - 12_000).toISOString(),
	};
}

function claimedAttempt(
	claim: Awaited<ReturnType<MagicBlockObservationStore["claim"]>>,
): number {
	if (claim.status !== "claimed") throw new Error("test expected claim");
	return claim.claimAttempt;
}

function auditResult(
	observationId: string,
	audit: Awaited<ReturnType<MagicBlockAppendOnlyAuditLedger["appendAtomic"]>>,
): MagicBlockDevnetObservationResultV1 {
	const commitmentDigest = sha256Hex("commitment", observationId);
	const previousLedgerDigest = audit.previousLedgerDigest ?? "0".repeat(64);
	const ledgerDigest = audit.ledgerDigest ?? sha256Hex("ledger", observationId);
	return {
		schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
		observationId,
		outcome: "review_required",
		audit: {
			auditEventId: audit.auditEventId,
			attestationDigest: audit.attestationDigest,
			resultDigest: sha256Hex("result", observationId),
			previousLedgerDigest,
			ledgerDigest,
			registration: {
				status: "confirmed",
				cluster: "devnet",
				routerUrl: "https://devnet-router.magicblock.app/",
				signature: "2".repeat(64),
				signer: "11111111111111111111111111111111",
				slot: 123,
				commitmentDigest,
				memo: `compass:audit:v1:${canonicalJson({
					a: audit.auditEventId,
					c: commitmentDigest,
					l: ledgerDigest,
					o: "review",
					p: previousLedgerDigest,
					v: 1,
				})}`,
				verifiedAt: NOW,
			},
		},
	};
}

function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

function appendInput(candidateDigestSeed: string) {
	return {
		schemaVersion: "magicblock-devnet-attestation/v1" as const,
		materialize(auditEventId: string) {
			const payload = {
				schemaVersion: "magicblock-devnet-attestation/v1" as const,
				eventType: "magicblock_devnet_audit_attestation" as const,
				auditEventId,
				occurredAt: NOW,
				cluster: "devnet" as const,
				candidateDigest: sha256Hex(candidateDigestSeed),
				decodedPlanDigest: sha256Hex("plan", candidateDigestSeed),
				evidence: {
					endpointHost: "devnet-router.magicblock.app" as const,
					method: "getDelegationStatus" as const,
					observedAt: NOW,
					accountDigests: [sha256Hex("account", candidateDigestSeed)],
					classifications: ["delegated" as const],
				},
				outcome: "review_required" as const,
				rationaleCode: "DELEGATION_STATUS_CONFIRMED" as const,
				registration: "required" as const,
			};
			const canonicalPayload = canonicalJson(payload);
			return {
				payload,
				canonicalPayload,
				attestationDigest: sha256Hex(
					"compass.magicblock-devnet-attestation/v1\0",
					canonicalPayload,
				),
			};
		},
	};
}
