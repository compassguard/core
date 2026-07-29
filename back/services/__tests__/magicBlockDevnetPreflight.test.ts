import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyToolCall } from "../../guardrail/execution/executionGateway";
import { createMagicBlockDevnetEvidenceAdapter } from "../magicBlockDevnetPreflightAdapter";
import {
	computeMagicBlockAttestationDigest,
	createMagicBlockDevnetAuditWriter,
} from "../magicBlockDevnetPreflightAuditWriter";
import { canonicalJson } from "../magicBlockDevnetPreflightCanonical";
import { createMagicBlockDevnetPreflight } from "../magicBlockDevnetPreflightIntegration";
import { createTrustedMagicBlockPlanProducer } from "../magicBlockDevnetPreflightProducer";
import {
	MAGICBLOCK_METHOD,
	MAGICBLOCK_MAX_RESPONSE_BYTES,
	MAGICBLOCK_ROUTER_URL,
	type InternalMagicBlockCandidateSource,
	type InternalImmutableMagicBlockCandidate,
	type MagicBlockAppendOnlyAuditLedger,
	type MagicBlockPost,
	type MaterializedMagicBlockAuditEvent,
	type TrustedMagicBlockPlanSnapshot,
	type TrustedMagicBlockPlanStore,
} from "../magicBlockDevnetPreflightTypes";

const root = resolve(__dirname, "../../..");
const closureScript = resolve(
	root,
	"scripts/verify-magicblock-preflight-dependency-closure.mjs",
);
const approvalScript = resolve(root, "scripts/verify-magicblock-preflight-approval.mjs");
const observedAt = "2026-07-28T12:00:00.000Z";
const occurredAt = "2026-07-28T12:00:01.000Z";
const publicKeys = [
	"11111111111111111111111111111111",
	"ComputeBudget111111111111111111111111111111",
] as const;
const documentedDelegationRecord = {
	authority: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
	owner: "3JnJ727jWEmPVU8qfXwtH63sCNDX7nMgsLbg8qy8aaPX",
	delegationSlot: 388_473_478,
	lamports: 15_144_960,
} as const;

const candidate: InternalImmutableMagicBlockCandidate = {
	schemaVersion: "compass.magicblock-candidate/v1",
	cluster: "devnet",
	decodedPlan: {
		schemaVersion: "compass.decoded-action-plan/v1",
		actionKind: "account_delegation_review",
		accountIndexes: ["0", "1"],
	},
	accounts: [
		{
			publicKey: publicKeys[0],
			isSigner: true,
			isWritable: true,
			isProgram: false,
			isPayer: true,
		},
		{
			publicKey: publicKeys[1],
			isSigner: false,
			isWritable: false,
			isProgram: true,
			isPayer: false,
		},
	],
};

class TestPlanStore implements TrustedMagicBlockPlanStore {
	snapshot?: TrustedMagicBlockPlanSnapshot;
	mutate?: (snapshot: TrustedMagicBlockPlanSnapshot) => TrustedMagicBlockPlanSnapshot;

	async insertImmutable(snapshot: TrustedMagicBlockPlanSnapshot) {
		this.snapshot = structuredClone(snapshot);
	}

	async resolveImmutable() {
		if (!this.snapshot) return null;
		const cloned = structuredClone(this.snapshot);
		return this.mutate ? this.mutate(cloned) : cloned;
	}
}

class TestCandidateSource implements InternalMagicBlockCandidateSource {
	resolutions = 0;

	async resolveImmutable(opaqueRef: string) {
		this.resolutions += 1;
		return opaqueRef === "internal_candidate_1" ? structuredClone(candidate) : null;
	}
}

class TestLedger implements MagicBlockAppendOnlyAuditLedger {
	event?: MaterializedMagicBlockAuditEvent;
	fail = false;
	appends = 0;

	async appendAtomic(input: Parameters<MagicBlockAppendOnlyAuditLedger["appendAtomic"]>[0]) {
		this.appends += 1;
		if (this.fail) throw new Error("raw provider error must not escape");
		this.event = input.materialize("aud_magicblock_1");
		return {
			auditEventId: this.event.payload.auditEventId,
			attestationDigest: this.event.attestationDigest,
		};
	}
}

type ResponseMutation = (
	response: {
		status: number;
		url: string;
		redirected: boolean;
		body: string;
	},
	callIndex: number,
) => {
	status: number;
	url: string;
	redirected: boolean;
	body: string;
};

function respondingPost(
	statuses: readonly ("delegated" | "base_layer")[] = ["delegated", "delegated"],
	mutate?: ResponseMutation,
) {
	const requests: Parameters<MagicBlockPost>[0][] = [];
	const post: MagicBlockPost = async (request) => {
		requests.push(request);
		const requestBody = JSON.parse(request.body);
		const callIndex = requests.length - 1;
		const isDelegated = (statuses[callIndex] ?? "delegated") === "delegated";
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: requestBody.id,
			result: {
				isDelegated,
				...(isDelegated
					? {
							fqdn: "https://devnet-as.magicblock.app/",
							delegationRecord: documentedDelegationRecord,
						}
					: {}),
			},
		});
		const response = {
			status: 200,
			url: MAGICBLOCK_ROUTER_URL,
			redirected: false,
			body,
		};
		return mutate ? mutate(response, callIndex) : response;
	};
	return { post, requests };
}

async function setup(options?: {
	enabled?: boolean;
	statuses?: readonly ("delegated" | "base_layer")[];
	mutateResponse?: ResponseMutation;
	store?: TestPlanStore;
	ledger?: TestLedger;
}) {
	const store = options?.store ?? new TestPlanStore();
	const ledger = options?.ledger ?? new TestLedger();
	const candidateSource = new TestCandidateSource();
	let id = 0;
	const producer = createTrustedMagicBlockPlanProducer({
		candidateSource,
		store,
		createOpaqueId: (kind) => `${kind}_${++id}`,
	});
	const reference = await producer.produce({
		schemaVersion: "compass.internal-magicblock-candidate-ref/v1",
		opaqueRef: "internal_candidate_1",
	});
	const transport = respondingPost(options?.statuses, options?.mutateResponse);
	const adapter = createMagicBlockDevnetEvidenceAdapter({
		enabled: options?.enabled,
		post: transport.post,
		now: () => observedAt,
	});
	const auditWriter = createMagicBlockDevnetAuditWriter({
		ledger,
		now: () => occurredAt,
	});
	const preflight = createMagicBlockDevnetPreflight({
		enabled: options?.enabled,
		producer,
		adapter,
		auditWriter,
	});
	return {
		store,
		ledger,
		candidateSource,
		producer,
		reference,
		transport,
		adapter,
		auditWriter,
		preflight,
	};
}

describe("MagicBlock devnet local audit preflight", () => {
	it("is disabled by default and makes zero provider calls", async () => {
		const harness = await setup();
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(harness.transport.requests).toHaveLength(0);
		expect(harness.ledger.appends).toBe(0);

		const resolved = await harness.producer.resolve(harness.reference);
		await expect(harness.adapter.collect(resolved)).resolves.toEqual({
			status: "unavailable",
		});
		expect(harness.transport.requests).toHaveLength(0);
	});

	it("uses only the literal POST endpoint and getDelegationStatus", async () => {
		const harness = await setup({ enabled: true });
		await expect(harness.preflight.review(harness.reference)).resolves.toMatchObject({
			outcome: "review_required",
			audit: { auditEventId: "aud_magicblock_1" },
		});
		expect(harness.transport.requests).toHaveLength(2);
		for (const request of harness.transport.requests) {
			expect(request).toMatchObject({
				url: "https://devnet-router.magicblock.app/",
				method: "POST",
				redirect: "error",
				headers: { "content-type": "application/json" },
				maxResponseBytes: MAGICBLOCK_MAX_RESPONSE_BYTES,
			});
			const body = JSON.parse(request.body);
			expect(body.method).toBe(MAGICBLOCK_METHOD);
			expect(Object.keys(body).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
			expect(Number.isSafeInteger(body.id)).toBe(true);
			expect(body.params).toEqual([publicKeys[harness.transport.requests.indexOf(request)]]);
			expect(typeof body.params[0]).toBe("string");
		}
	});

	it("uses the official one-account parameter and never sends Compass binding objects", async () => {
		const harness = await setup({ enabled: true });
		const resolved = await harness.producer.resolve(harness.reference);
		await expect(harness.adapter.collect(resolved)).resolves.toMatchObject({
			status: "available",
		});
		for (const [index, request] of harness.transport.requests.entries()) {
			const body = JSON.parse(request.body);
			expect(body.params).toEqual([publicKeys[index]]);
			expect(Object.keys(body.params)).toEqual(["0"]);
			expect(request.body).not.toContain("candidateId");
			expect(request.body).not.toContain("candidateDigest");
			expect(request.body).not.toContain("accountDigest");
		}
	});

	it("accepts the required official isDelegated result without optional metadata", async () => {
		const harness = await setup({
			enabled: true,
			mutateResponse: (response) => {
				const body = JSON.parse(response.body);
				body.result = { isDelegated: body.result.isDelegated };
				return { ...response, body: JSON.stringify(body) };
			},
		});
		await expect(harness.preflight.review(harness.reference)).resolves.toMatchObject({
			outcome: "review_required",
		});
		expect(harness.ledger.appends).toBe(1);
	});

	it.each([
		[
			"old response containing only the invented Compass delegationRecord",
			{
				delegationRecord: {
					schemaVersion: "magicblock.delegation-record/v1",
					candidateId: "candidate_1",
					candidateDigest: "0".repeat(64),
					accountDigest: "1".repeat(64),
					status: "delegated",
					evaluatedSlot: "123",
					commitment: "confirmed",
					evidence: { endpointHost: "devnet-as.magicblock.app" },
				},
			},
		],
		[
			"required isDelegated combined with the invented Compass delegationRecord",
			{
				isDelegated: true,
				delegationRecord: {
					schemaVersion: "magicblock.delegation-record/v1",
					candidateId: "candidate_1",
					candidateDigest: "0".repeat(64),
					accountDigest: "1".repeat(64),
					status: "delegated",
					evaluatedSlot: "123",
					commitment: "confirmed",
					evidence: { endpointHost: "devnet-as.magicblock.app" },
				},
			},
		],
	] as const)("rejects %s", async (_name, result) => {
		const harness = await setup({
			enabled: true,
			mutateResponse: (response) => {
				const body = JSON.parse(response.body);
				body.result = result;
				return { ...response, body: JSON.stringify(body) };
			},
		});
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(harness.ledger.appends).toBe(0);
	});

	it("uses a unique evaluation binding and rejects a response replayed into another evaluation", async () => {
		const harness = await setup({ enabled: true });
		const resolved = await harness.producer.resolve(harness.reference);
		const firstResponses: string[] = [];
		const requestIds: number[] = [];
		let calls = 0;
		const adapter = createMagicBlockDevnetEvidenceAdapter({
			enabled: true,
			now: () => observedAt,
			createEvaluationId: (() => {
				let evaluation = 0;
				return () => `evaluation_${++evaluation}`;
			})(),
			post: async (request) => {
				const body = JSON.parse(request.body);
				requestIds.push(body.id);
				const accountIndex = calls % 2;
				calls += 1;
				if (calls > 2) {
					return {
						status: 200,
						url: MAGICBLOCK_ROUTER_URL,
						redirected: false,
						body: firstResponses[accountIndex],
					};
				}
				const responseBody = JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						isDelegated: true,
						fqdn: "https://devnet-as.magicblock.app/",
						delegationRecord: documentedDelegationRecord,
					},
				});
				firstResponses.push(responseBody);
				return {
					status: 200,
					url: MAGICBLOCK_ROUTER_URL,
					redirected: false,
					body: responseBody,
				};
			},
		});

		await expect(adapter.collect(resolved)).resolves.toMatchObject({ status: "available" });
		await expect(adapter.collect(resolved)).resolves.toEqual({ status: "unavailable" });
		expect(requestIds[0]).not.toBe(requestIds[2]);
	});

	it("lets callers submit only a closed opaque internal-candidate reference", async () => {
		const harness = await setup({ enabled: true });
		await expect(
			harness.producer.produce({
				schemaVersion: "compass.internal-magicblock-candidate-ref/v1",
				opaqueRef: "missing_candidate",
			}),
		).rejects.toThrow("trusted plan unavailable");
		await expect(
			harness.producer.produce({
				schemaVersion: "compass.internal-magicblock-candidate-ref/v1",
				opaqueRef: "internal_candidate_1",
				candidate,
			} as never),
		).rejects.toThrow("trusted plan unavailable");
		expect(harness.candidateSource.resolutions).toBe(2);
	});

	it.each([
		[["delegated", "delegated"], "review_required", "DELEGATION_STATUS_CONFIRMED"],
		[["delegated", "base_layer"], "incompatible", "DELEGATION_STATUS_INCOMPATIBLE"],
	] as const)("maps closed provider statuses to audit-only outcomes", async (statuses, outcome, rationale) => {
		const harness = await setup({ enabled: true, statuses });
		await expect(harness.preflight.review(harness.reference)).resolves.toMatchObject({
			outcome,
		});
		expect(harness.ledger.event?.payload).toMatchObject({
			outcome,
			rationaleCode: rationale,
			registration: "required",
		});
	});

	it.each([
		[
			"redirect",
			(response: ReturnType<ResponseMutation>) => ({ ...response, redirected: true }),
		],
		[
			"response URL",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				url: "https://devnet-router.magicblock.app/redirected",
			}),
		],
		[
			"malformed JSON",
			(response: ReturnType<ResponseMutation>) => ({ ...response, body: "{" }),
		],
		[
			"oversized JSON",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: "x".repeat(MAGICBLOCK_MAX_RESPONSE_BYTES + 1),
			}),
		],
		[
			"excessive JSON depth",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: `${"[".repeat(40)}0${"]".repeat(40)}`,
			}),
		],
		[
			"extra result field",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace('"isDelegated":true', '"isDelegated":true,"extra":true'),
			}),
		],
		[
			"duplicate member",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace(
					'"isDelegated":true',
					'"isDelegated":true,"isDelegated":false',
				),
			}),
		],
		[
			"missing required isDelegated",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace('"isDelegated":true,', ""),
			}),
		],
		[
			"string JSON-RPC response id",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.id = String(parsed.id);
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"invalid fqdn metadata type",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace(
					'"fqdn":"https://devnet-as.magicblock.app/"',
					'"fqdn":42',
				),
			}),
		],
		[
			"empty fqdn metadata",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.fqdn = "";
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"control character in fqdn metadata",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.fqdn = "https://devnet-as.magicblock.app/\u0000";
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"overlong fqdn metadata",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.fqdn = "a".repeat(2_049);
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"extra official delegation record field",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.commitment = "confirmed";
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"unsafe integer delegation slot",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.delegationSlot = Number.MAX_SAFE_INTEGER + 1;
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"negative lamports",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.lamports = -1;
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"noncanonical delegation authority",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.authority = "z".repeat(44);
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"noncanonical delegation owner",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.owner = "not-a-solana-address";
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
	] as const)("fails closed for %s rejection", async (_name, mutateResponse) => {
		const harness = await setup({
			enabled: true,
			mutateResponse: (response, callIndex) =>
				callIndex === 0 ? mutateResponse(response) : response,
		});
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(harness.ledger.appends).toBe(0);
	});

	it.each([
		[
			"candidate digest",
			(snapshot: TrustedMagicBlockPlanSnapshot) => {
				(snapshot.plan as { candidateDigest: string }).candidateDigest = "0".repeat(64);
				return snapshot;
			},
		],
		[
			"decoded plan digest",
			(snapshot: TrustedMagicBlockPlanSnapshot) => {
				(snapshot.plan as { decodedPlanDigest: string }).decodedPlanDigest = "0".repeat(64);
				return snapshot;
			},
		],
		[
			"account digest",
			(snapshot: TrustedMagicBlockPlanSnapshot) => {
				(snapshot.accountBindings[0] as { accountDigest: string }).accountDigest = "0".repeat(64);
				return snapshot;
			},
		],
		[
			"account flag",
			(snapshot: TrustedMagicBlockPlanSnapshot) => {
				(snapshot.accountBindings[0] as { isSigner: boolean }).isSigner = false;
				return snapshot;
			},
		],
	] as const)("recomputes and rejects a stored %s mismatch before provider use", async (_name, mutate) => {
		const store = new TestPlanStore();
		const harness = await setup({ enabled: true, store });
		store.mutate = mutate;
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(harness.transport.requests).toHaveLength(0);
		expect(harness.ledger.appends).toBe(0);
	});

	it("persists only the closed redacted audit payload", async () => {
		const harness = await setup({ enabled: true });
		await harness.preflight.review(harness.reference);
		const event = harness.ledger.event;
		expect(event).toBeDefined();
		expect(Object.keys(event!.payload).sort()).toEqual([
			"auditEventId",
			"candidateDigest",
			"cluster",
			"decodedPlanDigest",
			"eventType",
			"evidence",
			"observationId",
			"occurredAt",
			"outcome",
			"rationaleCode",
			"registration",
			"requestDigest",
			"resultDigest",
			"schemaVersion",
			"transactionDigest",
		]);
		const serialized = JSON.stringify(event);
		for (const forbidden of [
			...publicKeys,
			"unsignedTransactionBase64",
			"signature",
			"approval",
			"execution",
			"raw provider error",
		]) {
			expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
		}

		const resolved = await harness.producer.resolve(harness.reference);
		const collected = await harness.adapter.collect(resolved);
		expect(collected.status).toBe("available");
		if (collected.status !== "available") throw new Error("test setup unavailable");
		await expect(
			harness.auditWriter.write({
				resolvedPlan: resolved,
				evidence: collected.evidence,
				outcome: "review_required",
				rationaleCode: "DELEGATION_STATUS_CONFIRMED",
				rawTransaction: "forbidden",
			} as never),
		).rejects.toThrow("audit unavailable");
	});

	it("derives the only persistable outcome from validated classifications", async () => {
		const harness = await setup({ enabled: true });
		const resolved = await harness.producer.resolve(harness.reference);
		const collected = await harness.adapter.collect(resolved);
		if (collected.status !== "available") throw new Error("test setup unavailable");

		await expect(
			harness.auditWriter.write({
				resolvedPlan: resolved,
				evidence: collected.evidence,
				outcome: "unavailable",
				rationaleCode: "EVIDENCE_UNAVAILABLE",
			} as never),
		).rejects.toThrow("audit unavailable");
		await expect(
			harness.auditWriter.write({
				resolvedPlan: resolved,
				evidence: collected.evidence,
				outcome: "incompatible",
				rationaleCode: "DELEGATION_STATUS_INCOMPATIBLE",
			} as never),
		).rejects.toThrow("audit unavailable");

		const inconsistentEvidence = structuredClone(collected.evidence);
		(inconsistentEvidence.classifications as ("delegated" | "base_layer")[])[0] =
			"base_layer";
		await expect(
			harness.auditWriter.write({
				resolvedPlan: resolved,
				evidence: inconsistentEvidence,
			}),
		).rejects.toThrow("audit unavailable");
	});

	it("snapshots validated inputs before the ledger callback to prevent TOCTOU", async () => {
		const harness = await setup({ enabled: true });
		const mutableResolved = structuredClone(
			await harness.producer.resolve(harness.reference),
		);
		const collected = await harness.adapter.collect(mutableResolved);
		if (collected.status !== "available") throw new Error("test setup unavailable");
		const mutableEvidence = structuredClone(collected.evidence);
		const expectedCandidateDigest = mutableResolved.snapshot.plan.candidateDigest;
		const expectedAccountDigest = mutableEvidence.accountDigests[0];
		let persisted: MaterializedMagicBlockAuditEvent | undefined;
		const ledger: MagicBlockAppendOnlyAuditLedger = {
			async appendAtomic(input) {
				(
					mutableResolved.snapshot.plan as { candidateDigest: string }
				).candidateDigest = "0".repeat(64);
				(
					mutableResolved.snapshot.candidate.accounts[0] as { publicKey: string }
				).publicKey = publicKeys[1];
				(mutableEvidence.accountDigests as string[])[0] = "0".repeat(64);
				(
					mutableEvidence.classifications as ("delegated" | "base_layer")[]
				)[0] = "base_layer";
				persisted = input.materialize("aud_toctou_1");
				return {
					auditEventId: persisted.payload.auditEventId,
					attestationDigest: persisted.attestationDigest,
				};
			},
		};
		const writer = createMagicBlockDevnetAuditWriter({
			ledger,
			now: () => occurredAt,
		});

		await expect(
			writer.write({
				resolvedPlan: mutableResolved,
				evidence: mutableEvidence,
			}),
		).resolves.toMatchObject({ auditEventId: "aud_toctou_1" });
		expect(persisted?.payload).toMatchObject({
			candidateDigest: expectedCandidateDigest,
			outcome: "review_required",
			rationaleCode: "DELEGATION_STATUS_CONFIRMED",
			evidence: {
				classifications: ["delegated", "delegated"],
			},
		});
		expect(persisted?.payload.evidence.accountDigests[0]).toBe(expectedAccountDigest);
		expect(JSON.stringify(persisted)).not.toContain(publicKeys[0]);
		expect(JSON.stringify(persisted)).not.toContain(publicKeys[1]);
	});

	it("fails closed when the atomic audit append fails", async () => {
		const ledger = new TestLedger();
		ledger.fail = true;
		const harness = await setup({ enabled: true, ledger });
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(ledger.event).toBeUndefined();
	});

	it("uses deterministic RFC8785-equivalent canonicalization and a domain-separated digest", async () => {
		const harness = await setup({ enabled: true });
		await harness.preflight.review(harness.reference);
		const event = harness.ledger.event!;
		expect(event.canonicalPayload).toBe(canonicalJson(event.payload));
		const independentlyComputed = createHash("sha256")
			.update("compass.magicblock-devnet-attestation/v1\0")
			.update(event.canonicalPayload)
			.digest("hex");
		expect(event.attestationDigest).toBe(independentlyComputed);
		expect(computeMagicBlockAttestationDigest(event.payload)).toBe(independentlyComputed);
		expect(canonicalJson({ z: 1, a: { y: true, x: false } })).toBe(
			canonicalJson({ a: { x: false, y: true }, z: 1 }),
		);
	});

	it("does not treat simulate_transaction ALLOW as feature input or authorization", async () => {
		const classification = classifyToolCall({
			toolName: "simulate_transaction",
			mutates: false,
		});
		expect(classification.defaultDecision).toBe("ALLOW");
		const harness = await setup();
		expect(Object.keys(harness.reference).sort()).toEqual(["opaqueRef", "schemaVersion"]);
		await expect(harness.preflight.review(harness.reference)).resolves.toEqual({
			outcome: "unavailable",
		});
		expect(harness.transport.requests).toHaveLength(0);
		expect(JSON.stringify(harness.reference)).not.toContain("ALLOW");
	});
});

function fixture(files: Record<string, string>) {
	const directory = mkdtempSync(resolve(tmpdir(), "magicblock-preflight-"));
	for (const [path, source] of Object.entries(files)) {
		const file = resolve(directory, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source, "utf8");
	}
	return directory;
}

const MCP_SERVER_SEAM_EXTERNAL_IMPORT =
	'import "@modelcontextprotocol/sdk/types.js";';
const MCP_SERVER_EXTERNAL_IMPORTS =
	'import "node:url"; import "node:os"; import "node:crypto"; import "@modelcontextprotocol/sdk/client/index.js"; import "@modelcontextprotocol/sdk/client/stdio.js"; import "@modelcontextprotocol/sdk/server/index.js"; import "@modelcontextprotocol/sdk/server/stdio.js"; import "@modelcontextprotocol/sdk/types.js";';
const MCP_SERVER_LOCAL_IMPORTS =
	'import "@back/posthog/posthogClient"; import "@back/guardrail/debugLogger"; import "../../envConfig"; import "../config/loadRepoEnv"; import "../proxy/mcpProxyContracts"; import "../proxy/mcpProxyDispatcher"; import "./mcpProxyServerContracts"; import "../config/mcpRuntimeConfig"; import "../proxy/mcpHostedClient"; import "../proxy/mcpProxyAudit"; import "../observer/magicBlockMcpObserverConfig"; import "../observer/magicBlockHostedAuditClient"; import "../observer/magicBlockMcpObserver"; import "../observer/magicBlockMcpObserverContracts"; import "../observer/magicBlockMcpObservationExtractor";';
const MCP_EXTRACTOR_EXACT_MEMBER_USES =
	"export function extractMagicBlockObservationFromStructuredContent() { return Object.freeze({}); } function isBoundedCanonicalBase64(value, padding) { return value[value.length - padding - 1]; }";
const MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE =
	'const ENABLED_ENV = "enabled"; const URL_ENV = "url"; const API_KEY_ENV = "api-key"; const TIMEOUT_ENV = "timeout"; export function readMagicBlockMcpObserverEnvConfig(env = process.env) { return [env[ENABLED_ENV], env[URL_ENV], env[API_KEY_ENV], env[TIMEOUT_ENV]]; }';
const MCP_HOSTED_CLIENT_EXACT_GLOBAL_USE =
	"export function createMagicBlockHostedAuditClient() { return (url, init) => globalThis.fetch(url, init); }";
const MCP_SERVER_EXACT_GLOBAL_USES =
	"function resolveLocalInstallationId() { return process.cwd(); } Promise.resolve().catch(() => process.exit(1)); function isDirectExecution() { return process.argv[1] && pathToFileURL(process.argv[1]); } function createRuntimeDownstreamClient() { function startClient() { return { ...process.env }; } return startClient; }";

function completeFeature(files: Record<string, string>) {
	return {
		"back/services/magicBlockDevnetPreflightTypes.ts": "export {};",
		"back/services/magicBlockDevnetPreflightCanonical.ts": "export {};",
		"back/services/magicBlockDevnetObservationContracts.ts": "export {};",
		"back/services/magicBlockDevnetPreflightProducer.ts": "export {};",
		"back/services/magicBlockDevnetPreflightAdapter.ts": "export {};",
		"back/services/magicBlockDevnetPreflightIntegration.ts": "export {};",
		"back/services/magicBlockDevnetPreflightAuditWriter.ts": "export {};",
		"back/services/magicBlockDevnetTransactionDecoder.ts": "export {};",
		"back/services/magicBlockDevnetRequestScope.ts": "export {};",
		"back/services/magicBlockDevnetHttpsTransport.ts": "export {};",
		"hosted/magicblock/magicBlockAuditIngress.ts":
			'import "../../back/services/magicBlockDevnetObservationContracts"; export {};',
		"hosted/magicblock/magicBlockAuditIngressFromEnv.ts":
			'import "./magicBlockAuditIngress"; import "./magicBlockObservationStorePg"; import "./magicBlockAuditLedgerPg"; export {};',
		"hosted/magicblock/magicBlockObservationStorePg.ts": "export {};",
		"hosted/magicblock/magicBlockAuditLedgerPg.ts": "export {};",
		"app/api/magicblock-devnet/audit/route.ts":
			'import "../../../../hosted/magicblock/magicBlockAuditIngressFromEnv"; export {};',
		"back/services/mcp/observer/magicBlockMcpObserverContracts.ts":
			"export {};",
		"back/services/mcp/observer/magicBlockMcpObservationExtractor.ts":
			`import "../../magicBlockDevnetObservationContracts"; import "../../magicBlockDevnetPreflightCanonical"; import "./magicBlockMcpObserverContracts"; ${MCP_EXTRACTOR_EXACT_MEMBER_USES}`,
		"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
			`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE}`,
		"back/services/mcp/observer/magicBlockHostedAuditClient.ts":
			`import "./magicBlockMcpObserverContracts"; import "./magicBlockMcpObserverConfig"; ${MCP_HOSTED_CLIENT_EXACT_GLOBAL_USE}`,
		"back/services/mcp/observer/magicBlockMcpObserver.ts":
			'import "./magicBlockMcpObserverContracts"; export {};',
		"back/services/mcp/server/mcpProxyServerContracts.ts":
			`${MCP_SERVER_SEAM_EXTERNAL_IMPORT} import "../proxy/mcpProxyContracts"; import "../observer/magicBlockMcpObserverContracts"; export {};`,
		"back/services/mcp/server/mcpServer.ts":
			`${MCP_SERVER_EXTERNAL_IMPORTS} ${MCP_SERVER_LOCAL_IMPORTS} ${MCP_SERVER_EXACT_GLOBAL_USES} export {};`,
		"back/posthog/posthogClient.ts": "export {};",
		"back/guardrail/debugLogger.ts": "export {};",
		"back/services/envConfig.ts": "export {};",
		"back/services/mcp/config/loadRepoEnv.ts": "export {};",
		"back/services/mcp/config/mcpRuntimeConfig.ts": "export {};",
		"back/services/mcp/proxy/mcpProxyContracts.ts": "export {};",
		"back/services/mcp/proxy/mcpHostedClient.ts": "export {};",
		"back/services/mcp/proxy/mcpProxyAudit.ts": "export {};",
		"back/services/mcp/proxy/mcpProxyDispatcher.ts": "export {};",
		"back/guardrail/execution/executionGateway.ts": "export {};",
		...files,
	};
}

function verify(directory: string) {
	return spawnSync(process.execPath, [closureScript, "--root", directory], {
		encoding: "utf8",
	});
}

describe("MagicBlock dependency and strategic gates", () => {
	it("approves the corrected on-chain design without opening execution boundaries", () => {
		const result = verify(root);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("accepts only the required exact observer global-use shapes", () => {
		const directory = fixture(completeFeature({}));
		try {
			const result = verify(directory);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps the strategic Board gate explicitly blocked", () => {
		const result = spawnSync(process.execPath, [approvalScript, "--root", root], {
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("immutable Board approval evidence is required");
	});

	it("fails closed when any canonical feature root is absent", () => {
		const directory = fixture({
			"back/services/magicBlockDevnetPreflightTypes.ts": "export {};",
			"back/services/magicBlockDevnetPreflightCanonical.ts": "export {};",
			"back/services/magicBlockDevnetPreflightProducer.ts": "export {};",
			"back/services/magicBlockDevnetPreflightAdapter.ts": "export {};",
			"back/services/magicBlockDevnetPreflightIntegration.ts": "export {};",
			"back/guardrail/execution/executionGateway.ts": "export {};",
		});
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("incomplete MagicBlock preflight topology");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("allows ordinary bare package imports outside the feature closure", () => {
		const directory = fixture(
			completeFeature({
				"back/guardrail/execution/executionGateway.ts":
					'import "hono"; export {};',
				"shared/ordinaryConsumer.ts": 'import "postgres"; export {};',
			}),
		);
		try {
			expect(verify(directory).status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not treat capability names in feature comments or strings as runtime use", () => {
		const directory = fixture(
			completeFeature({
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'// globalThis.fetch and WebSocket are forbidden runtime capabilities\nexport const documentation = "fetch WebSocket process";',
			}),
		);
		try {
			expect(verify(directory).status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects every feature consumer outside the exact audit-ingress closure", () => {
		const directory = fixture(
			completeFeature({
				"shared/rogueMagicBlockConsumer.ts":
					'import "../back/services/magicBlockDevnetObservationContracts"; export {};',
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("unauthorized MagicBlock preflight consumer");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not grant feature privilege to a transitive shared ingress dependency", () => {
		const directory = fixture(
			completeFeature({
				"hosted/magicblock/magicBlockAuditIngress.ts":
					'import "../../back/services/magicBlockDevnetObservationContracts"; import "../../shared/ingressHelper"; export {};',
				"shared/ingressHelper.ts":
					'import "../back/services/magicBlockDevnetPreflightTypes"; export {};',
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("unauthorized MagicBlock preflight consumer");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects observer implementation reachability into the MCP dispatcher", () => {
		const directory = fixture(
			completeFeature({
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; import "../proxy/mcpProxyDispatcher"; export {};',
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"unauthorized direct edge from MCP audit observer",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"MCP observer contracts",
			"back/services/mcp/observer/magicBlockMcpObserverContracts.ts",
			'import "../../magicBlockDevnetObservationContracts"; export {};',
		],
		[
			"MCP observer config",
			"back/services/mcp/observer/magicBlockMcpObserverConfig.ts",
			`import "./magicBlockMcpObserverContracts"; import "../../magicBlockDevnetObservationContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE}`,
		],
		[
			"MCP hosted audit client",
			"back/services/mcp/observer/magicBlockHostedAuditClient.ts",
			`import "./magicBlockMcpObserverContracts"; import "./magicBlockMcpObserverConfig"; import "../../magicBlockDevnetObservationContracts"; ${MCP_HOSTED_CLIENT_EXACT_GLOBAL_USE}`,
		],
		[
			"MCP audit observer",
			"back/services/mcp/observer/magicBlockMcpObserver.ts",
			'import "./magicBlockMcpObserverContracts"; import "../../magicBlockDevnetObservationContracts"; export {};',
		],
		[
			"MCP server observer seam",
			"back/services/mcp/server/mcpProxyServerContracts.ts",
			`${MCP_SERVER_SEAM_EXTERNAL_IMPORT} import "../proxy/mcpProxyContracts"; import "../observer/magicBlockMcpObserverContracts"; import "../../magicBlockDevnetObservationContracts"; export {};`,
		],
	])("rejects feature imports from %s", (role, path, source) => {
		const directory = fixture(completeFeature({ [path]: source }));
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(`unauthorized direct edge from ${role}`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("allows the extractor only its exact observation contract/helper ingress", () => {
		const directory = fixture(
			completeFeature({
				"back/services/mcp/observer/magicBlockMcpObservationExtractor.ts":
					`import "../../magicBlockDevnetObservationContracts"; import "../../magicBlockDevnetPreflightCanonical"; import "./magicBlockMcpObserverContracts"; import "../../magicBlockDevnetPreflightAdapter"; ${MCP_EXTRACTOR_EXACT_MEMBER_USES}`,
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"unauthorized direct edge from MCP structured-content extractor",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects an MCP server bypass around the approved observer ingress", () => {
		const directory = fixture(
			completeFeature({
				"back/services/mcp/server/mcpServer.ts":
					`${MCP_SERVER_EXTERNAL_IMPORTS} ${MCP_SERVER_LOCAL_IMPORTS} import "../../magicBlockDevnetObservationContracts"; ${MCP_SERVER_EXACT_GLOBAL_USES} export {};`,
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"unauthorized direct edge from MCP server entrypoint",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"unexpected Solana SDK dependency",
			{
				"back/services/mcp/observer/magicBlockHostedAuditClient.ts":
					`import "./magicBlockMcpObserverContracts"; import "./magicBlockMcpObserverConfig"; import "@solana/web3.js"; ${MCP_HOSTED_CLIENT_EXACT_GLOBAL_USE}`,
			},
			"unexpected external dependency @solana/web3.js from MCP hosted audit client",
		],
		[
			"dangerous Node builtin",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; import "node:child_process"; export {};',
			},
			"unexpected external dependency node:child_process from MCP audit observer",
		],
		[
			"TypeScript import-type dependency",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; type SolanaConnection = import("@solana/web3.js").Connection; export type { SolanaConnection };',
			},
			"unexpected external dependency @solana/web3.js from MCP audit observer",
		],
		[
			"unresolved observer import",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; import "./missingObserverDependency"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE}`,
			},
			"unresolved import ./missingObserverDependency from MCP observer config",
		],
		[
			"observer import outside source roots",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; import "../../../../scripts/observerBypass.mjs"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE}`,
				"scripts/observerBypass.mjs": "export {};",
			},
			"out-of-scope local import ../../../../scripts/observerBypass.mjs from MCP observer config",
		],
		[
			"CommonJS require bypass",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; require("./magicBlockMcpObserverContracts"); export {};',
			},
			"unsupported CommonJS usage in MCP audit observer",
		],
		[
			"createRequire bypass",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; import { createRequire } from "node:module"; export {};',
			},
			"unsupported CommonJS usage in MCP audit observer",
		],
		[
			"literal dynamic import bypass",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; import("./magicBlockMcpObserverContracts"); export {};',
			},
			"dynamic import is not allowed in MCP audit observer",
		],
		[
			"process builtin loader bypass",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE} process.getBuiltinModule("node:child_process");`,
			},
			"runtime module loader process.getBuiltinModule is not allowed in MCP observer config",
		],
		[
			"aliased process global",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE} const processAlias = process; export { processAlias };`,
			},
			"unapproved global capability use process:unapproved-reference@<top-level> in MCP observer config",
		],
		[
			"aliased process loader",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE} const loader = process.getBuiltinModule; loader("node:child_process");`,
			},
			"unapproved global capability use process:unapproved-reference@<top-level> in MCP observer config",
		],
		[
			"Reflect.get global fetch",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; Reflect.get(globalThis, "fetch")("https://example.test"); export {};',
			},
			"unapproved global capability use Reflect:unapproved-reference@<top-level> in MCP audit observer",
		],
		[
			"computed global capability name",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; globalThis[["fe", "tch"].join("")]("https://example.test"); export {};',
			},
			"unapproved computed member access unrecognized:globalThis[[\"fe\", \"tch\"].join(\"\")]@<top-level> in MCP audit observer",
		],
		[
			"process binding loader",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE} process.binding("fs");`,
			},
			"runtime module loader process.binding is not allowed in MCP observer config",
		],
		[
			"process dlopen loader",
			{
				"back/services/mcp/observer/magicBlockMcpObserverConfig.ts":
					`import "./magicBlockMcpObserverContracts"; ${MCP_OBSERVER_CONFIG_EXACT_GLOBAL_USE} process.dlopen({}, "./native.node");`,
			},
			"runtime module loader process.dlopen is not allowed in MCP observer config",
		],
		[
			"destructured global fetch",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { fetch: indirectFetch } = globalThis; indirectFetch("https://example.test"); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"indirect global fetch call",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const indirectFetch = globalThis.fetch; indirectFetch("https://example.test"); export {};',
			},
			"unapproved global capability use globalThis:unapproved-reference@<top-level> in MCP audit observer",
		],
		[
			"reflective Function constructor",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const obtainProcess = (() => undefined).constructor("return process"); obtainProcess(); export {};',
			},
			"reflective capability constructor is not allowed in MCP audit observer",
		],
		[
			"aliased reflective Function constructor",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const construct = (() => undefined)["con" + "structor"]; const obtainProcess = construct("return process"); obtainProcess(); export {};',
			},
			"reflective capability constructor is not allowed in MCP audit observer",
		],
		[
			"nested computed Function constructor",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const fn = () => undefined; fn[["con", "structor"].join("")]("return fetch")(); export {};',
			},
			"unapproved computed member access unrecognized:fn[[\"con\", \"structor\"].join(\"\")]@<top-level> in MCP audit observer",
		],
		[
			"Object prototype reflection",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; Object.getPrototypeOf(() => undefined); export {};',
			},
			"unapproved global capability use Object:unapproved-reference@<top-level> in MCP audit observer",
		],
		[
			"Object property-descriptor reflection",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; Object.getOwnPropertyDescriptor(() => undefined, "constructor"); export {};',
			},
			"unapproved global capability use Object:unapproved-reference@<top-level> in MCP audit observer",
		],
		[
			"otherwise-benign unrecognized computed member",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const bag = { safe: true }; const key = "safe"; bag[key]; export {};',
			},
			"unapproved computed member access unrecognized:bag[key]@<top-level> in MCP audit observer",
		],
		[
			"optional unrecognized computed member",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const bag = { safe: true }; const key = "safe"; bag?.[key]; export {};',
			},
			"unapproved computed member access unrecognized:bag?.[key]@<top-level> in MCP audit observer",
		],
		[
			"duplicate otherwise-approved computed member",
			{
				"back/services/mcp/observer/magicBlockMcpObservationExtractor.ts":
					'import "../../magicBlockDevnetObservationContracts"; import "../../magicBlockDevnetPreflightCanonical"; import "./magicBlockMcpObserverContracts"; export function extractMagicBlockObservationFromStructuredContent() { return Object.freeze({}); } function isBoundedCanonicalBase64(value, padding) { value[value.length - padding - 1]; return value[value.length - padding - 1]; }',
			},
			"expected 1 exact value:index-last-data-character@isBoundedCanonicalBase64 computed access(es) in MCP structured-content extractor, found 2",
		],
		[
			"constructor binding alias",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { constructor: FunctionAlias } = () => undefined; FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"constructor shorthand binding",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { constructor } = () => undefined; constructor("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"nested constructor binding",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { nested: { constructor: FunctionAlias } } = { nested: () => undefined }; FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"constructor parameter binding with default",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; function derive({ constructor: FunctionAlias } = () => undefined) { return FunctionAlias("return fetch")(); } derive(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"string-literal constructor binding with property default",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { "constructor": FunctionAlias = () => undefined } = () => undefined; FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"computed constructor binding",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { ["con" + "structor"]: FunctionAlias } = () => undefined; FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"__proto__ binding alias",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { __proto__: prototypeAlias } = {}; export { prototypeAlias };',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"__proto__ shorthand binding",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { __proto__ } = {}; export { __proto__ };',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"nested string-literal __proto__ binding with default",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const { nested: { "__proto__": prototypeAlias = {} } } = { nested: {} }; export { prototypeAlias };',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"constructor destructuring assignment",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; let FunctionAlias; ({ constructor: FunctionAlias } = () => undefined); FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"__proto__ for-of destructuring assignment",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; let prototypeAlias; for ({ __proto__: prototypeAlias } of [{}]) { void prototypeAlias; } export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"array binding that derives a constructor",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; const [FunctionAlias] = [(() => undefined).constructor]; FunctionAlias("return fetch")(); export {};',
			},
			"binding/destructuring pattern is not allowed in MCP audit observer",
		],
		[
			"duplicate otherwise-approved fetch use",
			{
				"back/services/mcp/observer/magicBlockHostedAuditClient.ts":
					'import "./magicBlockMcpObserverContracts"; import "./magicBlockMcpObserverConfig"; export function createMagicBlockHostedAuditClient(url, init) { globalThis.fetch(url, init); return globalThis.fetch(url, init); }',
			},
			"expected 1 exact globalThis.fetch:direct-call-url-init@createMagicBlockHostedAuditClient use(s) in MCP hosted audit client, found 2",
		],
		[
			"unapproved observer runtime capability",
			{
				"back/services/mcp/observer/magicBlockMcpObserver.ts":
					'import "./magicBlockMcpObserverContracts"; globalThis.fetch("https://example.test"); export {};',
			},
			"unapproved global capability use globalThis:unapproved-reference@<top-level> in MCP audit observer",
		],
		[
			"missing required server builtin",
			{
				"back/services/mcp/server/mcpServer.ts":
					`${MCP_SERVER_EXTERNAL_IMPORTS.replace('import "node:crypto"; ', "")} ${MCP_SERVER_LOCAL_IMPORTS} ${MCP_SERVER_EXACT_GLOBAL_USES} export {};`,
			},
			"missing external dependency node:crypto from MCP server entrypoint",
		],
	] as const)("rejects MCP observer raw-import %s", (_name, files, error) => {
		const directory = fixture(completeFeature(files));
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(error);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects nonliteral dynamic imports anywhere in scanned source roots", () => {
		const directory = fixture(
			completeFeature({
				"shared/runtimeLoader.ts":
					"const target = './runtimeTarget'; import(target);",
				"shared/runtimeTarget.ts": "export {};",
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"nonliteral dynamic import in scanned source root",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("validates the ingress dependency closure independently", () => {
		const directory = fixture(
			completeFeature({
				"hosted/magicblock/magicBlockAuditIngressFromEnv.ts":
					'import "./magicBlockAuditIngress"; import "./magicBlockObservationStorePg"; import "./magicBlockAuditLedgerPg"; const target = "./magicBlockAuditIngress"; import(target);',
			}),
		);
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"nonliteral dynamic import in audit ingress closure",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"forward execution reachability",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'import "../guardrail/execution/executionGateway";',
			},
			"MagicBlock preflight reaches",
		],
		[
			"reverse execution reachability",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../services/magicBlockDevnetPreflightAdapter";',
			},
			"MagicBlock preflight reaches",
		],
		[
			"protected import of producer",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../services/magicBlockDevnetPreflightProducer";',
			},
			"MagicBlock preflight reaches",
		],
		[
			"protected import of types",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../services/magicBlockDevnetPreflightTypes";',
			},
			"MagicBlock preflight reaches",
		],
		[
			"MCP dispatcher import of observation contracts",
			{
				"back/services/mcp/proxy/mcpProxyDispatcher.ts":
					'import "../../magicBlockDevnetObservationContracts";',
			},
			"MagicBlock preflight reaches",
		],
		[
			"protected nonliteral dynamic import",
			{
				"back/guardrail/execution/executionGateway.ts":
					"const feature = '../../services/magicBlockDevnetPreflightProducer'; import(feature);",
			},
			"nonliteral dynamic import in protected source closure",
		],
		[
			"protected unresolved local import",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "./missingProtectedDependency";',
			},
			"unresolved import",
		],
		[
			"protected unresolved alias import",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "@back/services/missingProtectedDependency";',
			},
			"unresolved import",
		],
		[
			"protected out-of-scope local import",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../../outside/protectedBridge.mjs";',
				"outside/protectedBridge.mjs":
					'import "../back/services/magicBlockDevnetPreflightTypes.ts";',
			},
			"out-of-scope local import",
		],
		[
			"protected transitive nonliteral dynamic import",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../services/protectedTransitHelper";',
				"back/services/protectedTransitHelper.ts":
					"const feature = './magicBlockDevnetPreflightProducer'; import(feature);",
			},
			"nonliteral dynamic import in protected source closure",
		],
		[
			"protected transitive out-of-scope local import",
			{
				"back/guardrail/execution/executionGateway.ts":
					'import "../../services/protectedTransitHelper";',
				"back/services/protectedTransitHelper.ts":
					'import "../../outside/protectedTransitBridge.mjs";',
				"outside/protectedTransitBridge.mjs":
					'import "../back/services/magicBlockDevnetPreflightTypes.ts";',
			},
			"out-of-scope local import",
		],
		[
			"shared sibling bridge",
			{
				"shared/featureExecutionBridge.ts":
					'import "../back/services/magicBlockDevnetPreflightTypes"; import "../back/guardrail/execution/executionGateway";',
			},
			"bridges MagicBlock preflight and",
		],
		[
			"unresolved import",
			{ "back/services/magicBlockDevnetPreflightAdapter.ts": 'import "./missing";' },
			"unresolved import",
		],
		[
			"nonliteral dynamic import",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					"const moduleName = './safe'; import(moduleName);",
			},
			"nonliteral dynamic import",
		],
		[
			"Solana SDK dependency",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'import "@solana/web3.js";',
			},
			"forbidden external dependency",
		],
		[
			"network dependency",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'import { request } from "node:https";',
			},
			"forbidden external dependency",
		],
		[
			"direct fetch capability",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'export const result = fetch("https://example.test");',
			},
			"forbidden runtime capability fetch",
		],
		[
			"globalThis fetch capability",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'export const result = globalThis.fetch("https://example.test");',
			},
			"forbidden runtime capability fetch",
		],
		[
			"WebSocket capability",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'export const socket = new WebSocket("wss://example.test");',
			},
			"forbidden runtime capability WebSocket",
		],
		[
			"child process dependency",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'import { execFile } from "node:child_process"; execFile("curl", []);',
			},
			"forbidden external dependency node:child_process",
		],
		[
			"process execution capability",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'export const execution = process.mainModule;',
			},
			"forbidden runtime capability process",
		],
		[
			"out-of-scope local dependency",
			{
				"back/services/magicBlockDevnetPreflightAdapter.ts":
					'import "../../scripts/featureHelper.mjs";',
				"scripts/featureHelper.mjs": "export {};",
			},
			"out-of-scope local import",
		],
	] as const)("rejects %s", (_name, files, error) => {
		const directory = fixture(completeFeature(files));
		try {
			const result = verify(directory);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(error);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
