import { timingSafeEqual } from "node:crypto";

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
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockOnchainAudit";

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

	return {
		async handle(request) {
			if (!hasAuthorizedBearer(request.headers.get("authorization"), apiKey)) {
				return jsonError(
					401,
					"UNAUTHENTICATED",
					"Missing or invalid audit-ingress credentials.",
				);
			}
			if (request.method === "GET") {
				if (!input.runtime.auditRecords || !input.runtime.onchainAudit) {
					return jsonError(503, "UNAVAILABLE", "On-chain audit unavailable.");
				}
				const url = new URL(request.url);
				const auditEventId = url.searchParams.get("auditId");
				const signature = url.searchParams.get("signature");
				if (
					(auditEventId === null) === (signature === null) ||
					(auditEventId !== null && !isOpaqueIdentifier(auditEventId)) ||
					(signature !== null && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
				) {
					return jsonError(400, "BAD_REQUEST", "Provide exactly one auditId or signature.");
				}
				let record;
				try {
					record =
						auditEventId !== null
							? await input.runtime.auditRecords.findByAuditEventId(auditEventId)
							: await input.runtime.auditRecords.findBySignature(signature as string);
				} catch {
					return jsonError(503, "UNAVAILABLE", "Audit proof unavailable.");
				}
				if (!record) return jsonError(404, "NOT_FOUND", "Audit proof not found.");
				if (
					record.registration.status !== "confirmed" &&
					!record.registration.signature
				) {
					return Response.json(record, { status: 503 });
				}
				const commitment = materializeMagicBlockAuditCommitment(record.details);
				let verified;
				try {
					verified = await input.runtime.onchainAudit.verify({
						signature: record.registration.signature,
						expectedCommitmentDigest: commitment.commitmentDigest,
						expectedMemo: commitment.memo,
					});
				} catch {
					return jsonError(503, "UNAVAILABLE", "Audit verification unavailable.");
				}
				const refreshed = { ...record, registration: verified };
				await input.runtime.auditRecords.save(refreshed);
				return Response.json(refreshed, {
					status: verified.status === "confirmed" ? 200 : 503,
				});
			}
			if (request.method !== "POST") {
				return jsonError(405, "METHOD_NOT_ALLOWED", "GET or POST is required.");
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
			let durableAuditResult: MagicBlockDevnetObservationResultV1 | undefined;
			try {
				const decoded = decodeTrustedUnsignedV0NoAltCandidate(observation);
				const scoped = createRequestScopedMagicBlockDependencies({
					opaqueCandidateRef: `obs:${requestDigest}`,
					candidate: decoded.candidate,
				});
				const producer = createTrustedMagicBlockPlanProducer({
					candidateSource: scoped.candidateSource.source,
					store: scoped.planStore,
					createOpaqueId: (kind) =>
						`${kind}:${sha256Hex(
							"compass.magicblock-devnet-observation/v1/id\0",
							requestDigest,
							"\0",
							kind,
						).slice(0, 32)}`,
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
				const transactionDigest = sha256Hex(
					"compass.magicblock-devnet-observation/v1/transaction\0",
					Buffer.from(observation.unsignedTransactionBase64, "base64"),
				);
				const reviewed = await preflight.review(reference, {
					observationId: observation.observationId,
					transactionDigest,
					requestDigest,
				});
				if (reviewed.outcome !== "unavailable") {
					if (
						!reviewed.audit.resultDigest ||
						!reviewed.audit.previousLedgerDigest ||
						!reviewed.audit.ledgerDigest
					) {
						return jsonError(503, "UNAVAILABLE", "Audit commitment unavailable.");
					}
					const details = deepFreeze({
						schemaVersion: "compass.magicblock-audit-commitment/v1" as const,
						cluster: "devnet" as const,
						observationId: observation.observationId,
						auditEventId: reviewed.audit.auditEventId,
						transactionDigest,
						requestDigest,
						resultDigest: reviewed.audit.resultDigest,
						attestationDigest: reviewed.audit.attestationDigest,
						previousLedgerDigest: reviewed.audit.previousLedgerDigest,
						ledgerDigest: reviewed.audit.ledgerDigest,
						outcome: reviewed.outcome,
					});
					const auditFields = {
						auditEventId: reviewed.audit.auditEventId,
						attestationDigest: reviewed.audit.attestationDigest,
						resultDigest: reviewed.audit.resultDigest,
						previousLedgerDigest:
							reviewed.audit.previousLedgerDigest,
						ledgerDigest: reviewed.audit.ledgerDigest,
					};
					durableAuditResult = deepFreeze({
						schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
						observationId: observation.observationId,
						outcome: reviewed.outcome,
						audit: {
							...auditFields,
							registration: {
								status: "retryable_failure",
								retryable: true,
								code: "ROUTER_UNAVAILABLE",
							},
						},
					});
					if (!input.runtime.onchainAudit || !input.runtime.auditRecords) {
						return Response.json(durableAuditResult, { status: 503 });
					}
					const existingRecord =
						await input.runtime.auditRecords.findByAuditEventId(
							details.auditEventId,
						);
					const effectiveDetails = existingRecord?.details ?? details;
					const effectiveCommitment =
						materializeMagicBlockAuditCommitment(effectiveDetails);
					if (
						existingRecord &&
						(existingRecord.details.observationId !== observation.observationId ||
							existingRecord.details.transactionDigest !== transactionDigest ||
							existingRecord.details.requestDigest !== requestDigest ||
							existingRecord.details.auditEventId !==
								reviewed.audit.auditEventId ||
							existingRecord.details.attestationDigest !==
								reviewed.audit.attestationDigest ||
							existingRecord.details.resultDigest !==
								reviewed.audit.resultDigest ||
							existingRecord.details.previousLedgerDigest !==
								reviewed.audit.previousLedgerDigest ||
							existingRecord.details.ledgerDigest !==
								reviewed.audit.ledgerDigest ||
							existingRecord.details.outcome !== reviewed.outcome)
					) {
						throw new Error("persisted audit commitment mismatch");
					}
					const priorSignature =
						existingRecord &&
						"signature" in existingRecord.registration
							? existingRecord.registration.signature
							: undefined;
					const registration = priorSignature
						? await input.runtime.onchainAudit.verify({
								signature: priorSignature,
								expectedCommitmentDigest:
									effectiveCommitment.commitmentDigest,
								expectedMemo: effectiveCommitment.memo,
							})
							: await input.runtime.onchainAudit.register(
								effectiveDetails,
								async (prepared) => {
									const reserved =
										await input.runtime.auditRecords!.reservePrepared({
											record: {
												details: effectiveDetails,
												canonicalDetails:
													effectiveCommitment.canonicalDetails,
												registration: prepared,
											},
											requestDigest,
											claimAttempt: claim.claimAttempt,
										});
									if (
										reserved.registration.status !==
										"retryable_failure"
									) {
										throw new Error(
											"audit reservation unavailable",
										);
									}
									return reserved.registration;
								},
							);
					result = deepFreeze({
						schemaVersion: MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
						observationId: observation.observationId,
						outcome: effectiveDetails.outcome,
						audit: { ...auditFields, registration },
					});
					durableAuditResult = result;
					await input.runtime.auditRecords.save({
						details: effectiveDetails,
						canonicalDetails: effectiveCommitment.canonicalDetails,
						registration,
					});
					if (registration.status === "retryable_failure") {
						return Response.json(result, { status: 503 });
					}
				}
			} catch {
				if (durableAuditResult) {
					return Response.json(durableAuditResult, { status: 503 });
				}
			}

			if (result.outcome === "unavailable") {
				return Response.json(result, { status: 503 });
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
