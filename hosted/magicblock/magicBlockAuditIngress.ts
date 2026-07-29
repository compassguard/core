import { randomUUID, timingSafeEqual } from "node:crypto";

import {
	canonicalJson,
	deepFreeze,
	hasExactKeys,
	isCanonicalTimestamp,
	isOpaqueIdentifier,
	parseClosedJson,
	sha256Hex,
} from "@back/services/magicBlockDevnetPreflightCanonical";
import { createMagicBlockDevnetEvidenceAdapter } from "@back/services/magicBlockDevnetPreflightAdapter";
import { createMagicBlockDevnetAuditWriter } from "@back/services/magicBlockDevnetPreflightAuditWriter";
import { createMagicBlockDevnetPreflight } from "@back/services/magicBlockDevnetPreflightIntegration";
import {
	MAGICBLOCK_OBSERVATION_MAX_REQUEST_BYTES,
	MAGICBLOCK_OBSERVATION_CLAIM_LEASE_MS,
	MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
	MAGICBLOCK_OBSERVATION_SCHEMA,
	type MagicBlockAuditIngress,
	type MagicBlockAuditIngressRuntimeDependencies,
	type MagicBlockDevnetObservationResultV1,
	type MagicBlockDevnetObservationV1,
} from "@back/services/magicBlockDevnetObservationContracts";
import { createTrustedMagicBlockPlanProducer } from "@back/services/magicBlockDevnetPreflightProducer";
import { createRequestScopedMagicBlockDependencies } from "@back/services/magicBlockDevnetRequestScope";
import { decodeTrustedUnsignedV0NoAltCandidate } from "@back/services/magicBlockDevnetTransactionDecoder";
import { MAGICBLOCK_ROUTE_DEADLINE_MS } from "@back/services/magicBlockDevnetPreflightTypes";

const REQUEST_DIGEST_DOMAIN = "compass.magicblock-devnet-observation/v1/request\0";

export function createMagicBlockAuditIngress(
	input:
		| { readonly enabled?: false }
		| {
				readonly enabled: true;
				readonly apiKey: string;
				readonly runtime: MagicBlockAuditIngressRuntimeDependencies;
		  },
): MagicBlockAuditIngress {
	if (input.enabled !== true) {
		return {
			async handle() {
				return jsonError(404, "NOT_FOUND", "Not found.");
			},
		};
	}

	if (input.apiKey.trim() === "") throw new Error("audit ingress unavailable");
	const apiKey = input.apiKey;
	const now = input.runtime.now ?? (() => new Date().toISOString());
	const nowEpochMs = input.runtime.nowEpochMs ?? Date.now;
	const createOpaqueId =
		input.runtime.createOpaqueId ??
		((kind: "candidate" | "plan") => `${kind}:${randomUUID()}`);

	return {
		async handle(request) {
			if (request.method !== "POST") {
				return jsonError(405, "METHOD_NOT_ALLOWED", "POST is required.");
			}
			if (!hasAuthorizedBearer(request.headers.get("authorization"), apiKey)) {
				return jsonError(
					401,
					"UNAUTHENTICATED",
					"Missing or invalid audit-ingress credentials.",
				);
			}
			const deadlineAtEpochMs = nowEpochMs() + MAGICBLOCK_ROUTE_DEADLINE_MS;
			if (!Number.isSafeInteger(deadlineAtEpochMs)) {
				return jsonError(503, "UNAVAILABLE", "Audit ingress unavailable.");
			}

			let observation: MagicBlockDevnetObservationV1;
			try {
				const body = await readBoundedBody(
					request,
					MAGICBLOCK_OBSERVATION_MAX_REQUEST_BYTES,
				);
				observation = validateObservation(parseClosedJson(body));
			} catch {
				return jsonError(400, "BAD_REQUEST", "Invalid MagicBlock observation.");
			}

			const requestDigest = sha256Hex(
				REQUEST_DIGEST_DOMAIN,
				canonicalJson(observation),
			);
			const receivedAt = now();
			if (!isCanonicalTimestamp(receivedAt)) {
				return jsonError(503, "UNAVAILABLE", "Audit ingress unavailable.");
			}
			const staleBefore = new Date(
				Date.parse(receivedAt) - MAGICBLOCK_OBSERVATION_CLAIM_LEASE_MS,
			).toISOString();
			const claimInput = {
				observationId: observation.observationId,
				requestDigest,
				receivedAt,
				staleBefore,
			} as const;

			let claim;
			try {
				claim = await input.runtime.observations.claim(claimInput);
			} catch {
				return jsonError(503, "UNAVAILABLE", "Observation persistence unavailable.");
			}
			if (claim.status === "conflict") {
				return jsonError(409, "IDEMPOTENCY_CONFLICT", "Observation ID conflict.");
			}
			if (claim.status === "completed") return Response.json(claim.result);
			if (claim.status === "pending") {
				return jsonError(409, "OBSERVATION_IN_PROGRESS", "Observation is in progress.");
			}

			let result: MagicBlockDevnetObservationResultV1 = deepFreeze({
				schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
				observationId: observation.observationId,
				outcome: "unavailable",
			});
			try {
				const decoded = decodeTrustedUnsignedV0NoAltCandidate(observation);
				const scoped = createRequestScopedMagicBlockDependencies({
					opaqueCandidateRef: `obs:${requestDigest}`,
					candidate: decoded.candidate,
				});
				const producer = createTrustedMagicBlockPlanProducer({
					candidateSource: scoped.candidateSource.source,
					store: scoped.planStore,
					createOpaqueId,
				});
				const reference = await producer.produce(scoped.candidateSource.reference);
				const adapter = createMagicBlockDevnetEvidenceAdapter({
					post: input.runtime.post,
					enabled: true,
					now,
					nowEpochMs,
					deadlineAtEpochMs,
				});
				const auditWriter = createMagicBlockDevnetAuditWriter({
					ledger: input.runtime.createLedger({
						observationId: observation.observationId,
						requestDigest,
						claimAttempt: claim.claimAttempt,
					}),
					now,
				});
				const preflight = createMagicBlockDevnetPreflight({
					enabled: true,
					producer,
					adapter,
					auditWriter,
				});
				const reviewed = await preflight.review(reference);
				if (reviewed.outcome !== "unavailable") {
					result = deepFreeze({
						schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
						observationId: observation.observationId,
						outcome: reviewed.outcome,
						audit: reviewed.audit,
					});
				}
			} catch {
				// Fail closed. Provider and decoder errors are never reflected or persisted.
			}

			let reconciled;
			try {
				reconciled = await input.runtime.observations.claim(claimInput);
			} catch {
				return jsonError(503, "UNAVAILABLE", "Observation persistence unavailable.");
			}
			if (reconciled.status === "completed") {
				return Response.json(reconciled.result);
			}
			if (reconciled.status === "conflict") {
				return jsonError(409, "IDEMPOTENCY_CONFLICT", "Observation ID conflict.");
			}
			if (result.outcome !== "unavailable") {
				return jsonError(503, "UNAVAILABLE", "Atomic audit persistence unavailable.");
			}

			const completedAt = now();
			if (!isCanonicalTimestamp(completedAt)) {
				return jsonError(503, "UNAVAILABLE", "Audit ingress unavailable.");
			}
			try {
					await input.runtime.observations.complete({
						observationId: observation.observationId,
						requestDigest,
						claimAttempt: claim.claimAttempt,
						result,
					completedAt,
				});
			} catch {
				return jsonError(503, "UNAVAILABLE", "Audit persistence unavailable.");
			}
			return Response.json(result);
		},
	};
}

function validateObservation(value: unknown): MagicBlockDevnetObservationV1 {
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"observationId",
			"unsignedTransactionBase64",
		]) ||
		value.schemaVersion !== MAGICBLOCK_OBSERVATION_SCHEMA ||
		!isOpaqueIdentifier(value.observationId) ||
		typeof value.unsignedTransactionBase64 !== "string"
	) {
		throw new Error("observation unavailable");
	}
	return deepFreeze({
		schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
		observationId: value.observationId,
		unsignedTransactionBase64: value.unsignedTransactionBase64,
	});
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
	const contentLength = request.headers.get("content-length");
	if (
		contentLength !== null &&
		(!/^(?:0|[1-9]\d*)$/.test(contentLength) ||
			Number(contentLength) > maximumBytes)
	) {
		throw new Error("observation unavailable");
	}
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > maximumBytes) {
				await reader.cancel("request exceeds limit").catch(() => undefined);
				throw new Error("observation unavailable");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function hasAuthorizedBearer(header: string | null, expected: string): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const actual = header.slice("Bearer ".length).trim();
	const actualBytes = new TextEncoder().encode(actual);
	const expectedBytes = new TextEncoder().encode(expected);
	return (
		actualBytes.byteLength === expectedBytes.byteLength &&
		timingSafeEqual(actualBytes, expectedBytes)
	);
}

function jsonError(
	status: number,
	code: string,
	message: string,
): Response {
	return Response.json({ error: { code, message } }, { status });
}
