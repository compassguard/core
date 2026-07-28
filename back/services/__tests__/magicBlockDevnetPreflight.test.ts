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
		const binding = requestBody.params[0];
		const callIndex = requests.length - 1;
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: requestBody.id,
			result: {
				delegationRecord: {
					schemaVersion: "magicblock.delegation-record/v1",
					candidateId: binding.candidateId,
					candidateDigest: binding.candidateDigest,
					accountDigest: binding.accountDigest,
					status: statuses[callIndex] ?? "delegated",
					evaluatedSlot: "123",
					commitment: "confirmed",
					evidence: { endpointHost: "devnet-as.magicblock.app" },
				},
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
		}
	});

	it("uses a unique evaluation binding and rejects a response replayed into another evaluation", async () => {
		const harness = await setup({ enabled: true });
		const resolved = await harness.producer.resolve(harness.reference);
		const firstResponses: string[] = [];
		const requestIds: string[] = [];
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
				const binding = body.params[0];
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
						delegationRecord: {
							schemaVersion: "magicblock.delegation-record/v1",
							candidateId: binding.candidateId,
							candidateDigest: binding.candidateDigest,
							accountDigest: binding.accountDigest,
							status: "delegated",
							evaluatedSlot: "123",
							commitment: "confirmed",
							evidence: { endpointHost: "devnet-as.magicblock.app" },
						},
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
			registration: "not_requested",
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
			"extra record field",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace('"evaluatedSlot":"123"', '"extra":true,"evaluatedSlot":"123"'),
			}),
		],
		[
			"duplicate member",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace(
					'"status":"delegated"',
					'"status":"delegated","status":"base_layer"',
				),
			}),
		],
		[
			"literal evidence host",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace("devnet-as.magicblock.app", "devnet-as.magicblock.app.evil"),
			}),
		],
		[
			"candidate binding",
			(response: ReturnType<ResponseMutation>) => ({
				...response,
				body: response.body.replace('"candidateId":"candidate_1"', '"candidateId":"candidate_other"'),
			}),
		],
		[
			"candidate digest binding",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.candidateDigest = "0".repeat(64);
				return { ...response, body: JSON.stringify(parsed) };
			},
		],
		[
			"account binding",
			(response: ReturnType<ResponseMutation>) => {
				const parsed = JSON.parse(response.body);
				parsed.result.delegationRecord.accountDigest = "0".repeat(64);
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
			"occurredAt",
			"outcome",
			"rationaleCode",
			"registration",
			"schemaVersion",
		]);
		const serialized = JSON.stringify(event);
		for (const forbidden of [
			...publicKeys,
			"transaction",
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

function completeFeature(files: Record<string, string>) {
	return {
		"back/services/magicBlockDevnetPreflightTypes.ts": "export {};",
		"back/services/magicBlockDevnetPreflightCanonical.ts": "export {};",
		"back/services/magicBlockDevnetPreflightProducer.ts": "export {};",
		"back/services/magicBlockDevnetPreflightAdapter.ts": "export {};",
		"back/services/magicBlockDevnetPreflightIntegration.ts": "export {};",
		"back/services/magicBlockDevnetPreflightAuditWriter.ts": "export {};",
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
	it("accepts the implemented local boundary graph", () => {
		const result = verify(root);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
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
