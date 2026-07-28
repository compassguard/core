import { randomUUID } from "node:crypto";

import {
	canonicalJson,
	deepFreeze,
	hasExactKeys,
	isCanonicalTimestamp,
	isOpaqueIdentifier,
	parseClosedJson,
	sha256Hex,
} from "./magicBlockDevnetPreflightCanonical";
import { verifyResolvedTrustedMagicBlockPlan } from "./magicBlockDevnetPreflightProducer";
import {
	MAGICBLOCK_AS_HOST,
	MAGICBLOCK_MAX_RESPONSE_BYTES,
	MAGICBLOCK_METHOD,
	MAGICBLOCK_ROUTER_HOST,
	MAGICBLOCK_ROUTER_URL,
	type DelegationRecordV1,
	type MagicBlockPost,
	type ResolvedTrustedMagicBlockPlan,
	type ValidatedMagicBlockEvidence,
} from "./magicBlockDevnetPreflightTypes";

const DECIMAL = /^(?:0|[1-9]\d*)$/;
const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);
const STATUSES = new Set(["delegated", "base_layer"]);

export function createMagicBlockDevnetEvidenceAdapter(input: {
	readonly post: MagicBlockPost;
	readonly enabled?: boolean;
	readonly now?: () => string;
	readonly createEvaluationId?: () => string;
}) {
	const enabled = input.enabled === true;
	const now = input.now ?? (() => new Date().toISOString());
	const createEvaluationId = input.createEvaluationId ?? randomUUID;

	return {
		async collect(
			resolvedInput: ResolvedTrustedMagicBlockPlan,
		): Promise<
			| { readonly status: "available"; readonly evidence: ValidatedMagicBlockEvidence }
			| { readonly status: "unavailable" }
		> {
			if (!enabled) return { status: "unavailable" };

			try {
				const resolved = verifyResolvedTrustedMagicBlockPlan(resolvedInput);
				const observedAt = now();
				if (!isCanonicalTimestamp(observedAt)) return { status: "unavailable" };
				const evaluationId = createEvaluationId();
				if (!isOpaqueIdentifier(evaluationId)) return { status: "unavailable" };
				const records: DelegationRecordV1[] = [];

				for (const binding of resolved.snapshot.accountBindings) {
					const requestId = `mbp:${sha256Hex(
						"compass.magicblock-devnet-preflight/v1/evaluation\0",
						evaluationId,
						"\0",
						observedAt,
						"\0",
						resolved.snapshot.plan.candidateId,
						"\0",
						resolved.snapshot.plan.candidateDigest,
						"\0",
						binding.accountDigest,
					)}`;
					const body = canonicalJson({
						jsonrpc: "2.0",
						id: requestId,
						method: MAGICBLOCK_METHOD,
						params: [
							{
								account: binding.publicKey,
								candidateId: resolved.snapshot.plan.candidateId,
								candidateDigest: resolved.snapshot.plan.candidateDigest,
								accountDigest: binding.accountDigest,
							},
						],
					});
					const response = await input.post({
						url: MAGICBLOCK_ROUTER_URL,
						method: "POST",
						redirect: "error",
						headers: { "content-type": "application/json" },
						body,
						maxResponseBytes: MAGICBLOCK_MAX_RESPONSE_BYTES,
					});
					if (
						response.status !== 200 ||
						response.redirected ||
						response.url !== MAGICBLOCK_ROUTER_URL ||
						typeof response.body !== "string" ||
						new TextEncoder().encode(response.body).byteLength >
							MAGICBLOCK_MAX_RESPONSE_BYTES
					) {
						return { status: "unavailable" };
					}
					const record = parseDelegationResponse(
						response.body,
						requestId,
						resolved.snapshot.plan.candidateId,
						resolved.snapshot.plan.candidateDigest,
						binding.accountDigest,
					);
					if (!record) return { status: "unavailable" };
					records.push(record);
				}

				return {
					status: "available",
					evidence: deepFreeze({
						schemaVersion: "magicblock.devnet-evidence/v1",
						endpointHost: MAGICBLOCK_ROUTER_HOST,
						method: MAGICBLOCK_METHOD,
						observedAt,
						accountDigests: deepFreeze(
							resolved.snapshot.accountBindings.map(({ accountDigest }) => accountDigest),
						),
						classifications: deepFreeze(records.map(({ status }) => status)),
						delegationRecords: deepFreeze(records),
					}),
				};
			} catch {
				return { status: "unavailable" };
			}
		},
	};
}

function parseDelegationResponse(
	body: string,
	requestId: string,
	candidateId: string,
	candidateDigest: string,
	accountDigest: string,
): DelegationRecordV1 | null {
	const parsed = parseClosedJson(body);
	if (
		!hasExactKeys(parsed, ["jsonrpc", "id", "result"]) ||
		parsed.jsonrpc !== "2.0" ||
		parsed.id !== requestId ||
		!hasExactKeys(parsed.result, ["delegationRecord"])
	) {
		return null;
	}
	const record = parsed.result.delegationRecord;
	if (
		!hasExactKeys(record, [
			"schemaVersion",
			"candidateId",
			"candidateDigest",
			"accountDigest",
			"status",
			"evaluatedSlot",
			"commitment",
			"evidence",
		]) ||
		record.schemaVersion !== "magicblock.delegation-record/v1" ||
		record.candidateId !== candidateId ||
		record.candidateDigest !== candidateDigest ||
		record.accountDigest !== accountDigest ||
		typeof record.status !== "string" ||
		!STATUSES.has(record.status) ||
		typeof record.evaluatedSlot !== "string" ||
		!DECIMAL.test(record.evaluatedSlot) ||
		typeof record.commitment !== "string" ||
		!COMMITMENTS.has(record.commitment) ||
		!hasExactKeys(record.evidence, ["endpointHost"]) ||
		record.evidence.endpointHost !== MAGICBLOCK_AS_HOST
	) {
		return null;
	}
	return deepFreeze(record as DelegationRecordV1);
}
