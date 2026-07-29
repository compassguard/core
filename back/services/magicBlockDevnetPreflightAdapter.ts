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
import { cloneOfficialDelegationStatus } from "./magicBlockDevnetPreflightSchema";
import {
	MAGICBLOCK_MAX_RESPONSE_BYTES,
	MAGICBLOCK_METHOD,
	MAGICBLOCK_ROUTER_HOST,
	MAGICBLOCK_ROUTER_URL,
	type MagicBlockDelegationStatus,
	type MagicBlockPost,
	type ResolvedTrustedMagicBlockPlan,
	type ValidatedMagicBlockEvidence,
} from "./magicBlockDevnetPreflightTypes";

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
				const statuses: MagicBlockDelegationStatus[] = [];

				for (const binding of resolved.snapshot.accountBindings) {
						const requestId = Number.parseInt(
							sha256Hex(
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
							).slice(0, 12),
						16,
					) + 1;
					const body = canonicalJson({
						jsonrpc: "2.0",
						id: requestId,
						method: MAGICBLOCK_METHOD,
						params: [binding.publicKey],
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
					const status = parseDelegationResponse(response.body, requestId);
					if (!status) return { status: "unavailable" };
					statuses.push(status);
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
						classifications: deepFreeze(
							statuses.map(({ isDelegated }) =>
								isDelegated ? "delegated" : "base_layer",
							),
						),
						delegationStatuses: deepFreeze(statuses),
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
	requestId: number,
): MagicBlockDelegationStatus | null {
	const parsed = parseClosedJson(body);
	if (
		!hasExactKeys(parsed, ["jsonrpc", "id", "result"]) ||
		parsed.jsonrpc !== "2.0" ||
		parsed.id !== requestId
	) {
		return null;
	}
	return cloneOfficialDelegationStatus(parsed.result);
}
