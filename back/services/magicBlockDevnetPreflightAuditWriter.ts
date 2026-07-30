import {
	canonicalJson,
	deepFreeze,
	hasExactKeys,
	isCanonicalTimestamp,
	isDigest,
	sha256Hex,
} from "./magicBlockDevnetPreflightCanonical";
import { verifyResolvedTrustedMagicBlockPlan } from "./magicBlockDevnetPreflightProducer";
import { cloneOfficialDelegationStatus } from "./magicBlockDevnetPreflightSchema";
import {
	MAGICBLOCK_METHOD,
	MAGICBLOCK_ROUTER_HOST,
	type MagicBlockAppendOnlyAuditLedger,
	type MagicBlockAuditWriteResult,
	type MagicBlockDevnetAuditPayloadV1,
	type MagicBlockPersistedAuditOutcome,
	type MagicBlockPersistedAuditRationale,
	type ResolvedTrustedMagicBlockPlan,
	type ValidatedMagicBlockEvidence,
} from "./magicBlockDevnetPreflightTypes";

const ATTESTATION_DOMAIN = "compass.magicblock-devnet-attestation/v1\0";
const AUDIT_EVENT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/;
const OUTCOME_RATIONALE: Readonly<
	Record<MagicBlockPersistedAuditOutcome, MagicBlockPersistedAuditRationale>
> = {
	review_required: "DELEGATION_STATUS_CONFIRMED",
	incompatible: "DELEGATION_STATUS_INCOMPATIBLE",
};

export function createMagicBlockDevnetAuditWriter(input: {
	readonly ledger: MagicBlockAppendOnlyAuditLedger;
	readonly now?: () => string;
}) {
	const now = input.now ?? (() => new Date().toISOString());

	return {
		async write(command: {
			readonly resolvedPlan: ResolvedTrustedMagicBlockPlan;
			readonly evidence: ValidatedMagicBlockEvidence;
			readonly observationId?: string;
			readonly transactionDigest?: string;
			readonly requestDigest?: string;
		}): Promise<MagicBlockAuditWriteResult> {
			const legacyCommand = hasExactKeys(command, ["resolvedPlan", "evidence"]);
			const observationId = command.observationId ?? "legacy-observation";
			const transactionDigest = command.transactionDigest ?? "0".repeat(64);
			const requestDigest = command.requestDigest ?? "0".repeat(64);
			if (
				(!legacyCommand && !hasExactKeys(command, [
					"resolvedPlan",
					"evidence",
					"observationId",
					"transactionDigest",
					"requestDigest",
				])) ||
				!/^[-A-Za-z0-9._:]{1,128}$/.test(observationId) ||
				!isDigest(transactionDigest) ||
				!isDigest(requestDigest)
			) {
				throw new Error("audit unavailable");
			}
			const resolved = verifyResolvedTrustedMagicBlockPlan(command.resolvedPlan);
			const evidence = validateEvidence(command.evidence, resolved);
			const outcome: MagicBlockPersistedAuditOutcome =
				evidence.classifications.includes("base_layer")
					? "incompatible"
					: "review_required";
			const rationaleCode = OUTCOME_RATIONALE[outcome];
			const resultDigest = sha256Hex(
				"compass.magicblock-devnet-result/v1\0",
				canonicalJson({
					observationId,
					outcome,
					rationaleCode,
				}),
			);
			const occurredAt = now();
			if (!isCanonicalTimestamp(occurredAt)) throw new Error("audit unavailable");
			const safeCommand = deepFreeze({
				candidateDigest: resolved.snapshot.plan.candidateDigest,
				decodedPlanDigest: resolved.snapshot.plan.decodedPlanDigest,
				observationId,
				transactionDigest,
				requestDigest,
				resultDigest,
				evidence: deepFreeze({
					endpointHost: MAGICBLOCK_ROUTER_HOST,
					method: MAGICBLOCK_METHOD,
					observedAt: evidence.observedAt,
					accountDigests: deepFreeze([...evidence.accountDigests]),
					classifications: deepFreeze([...evidence.classifications]),
				}),
				outcome,
				rationaleCode,
				occurredAt,
			});

			let materialized:
				| {
						readonly auditEventId: string;
						readonly attestationDigest: string;
				  }
				| undefined;
			let materializeCount = 0;
				const appended = await input.ledger.appendAtomic({
				schemaVersion: "magicblock-devnet-attestation/v1",
				materialize: (auditEventId) => {
					materializeCount += 1;
					if (materializeCount !== 1 || !AUDIT_EVENT_ID.test(auditEventId)) {
						throw new Error("audit unavailable");
					}
					const payload: MagicBlockDevnetAuditPayloadV1 = deepFreeze({
						schemaVersion: "magicblock-devnet-attestation/v1",
							eventType: "magicblock_devnet_audit_attestation",
							auditEventId,
							observationId: safeCommand.observationId,
							occurredAt: safeCommand.occurredAt,
							cluster: "devnet",
							transactionDigest: safeCommand.transactionDigest,
							requestDigest: safeCommand.requestDigest,
							resultDigest: safeCommand.resultDigest,
						candidateDigest: safeCommand.candidateDigest,
						decodedPlanDigest: safeCommand.decodedPlanDigest,
						evidence: safeCommand.evidence,
						outcome: safeCommand.outcome,
						rationaleCode: safeCommand.rationaleCode,
						registration: "required",
					});
					const canonicalPayload = canonicalJson(payload);
					const attestationDigest = sha256Hex(ATTESTATION_DOMAIN, canonicalPayload);
					materialized = { auditEventId, attestationDigest };
					return { payload, canonicalPayload, attestationDigest };
				},
				});
				const reused =
					"reused" in appended && appended.reused === true;
				const persistedPayload =
					typeof appended.canonicalPayload === "string"
						? parsePersistedPayload(appended.canonicalPayload)
						: undefined;
				if (
					(!reused && (materializeCount !== 1 || !materialized)) ||
					(reused && materializeCount !== 0) ||
					!hasAllowedAppendResult(appended) ||
					(!reused && appended.auditEventId !== materialized?.auditEventId) ||
					(!reused && appended.attestationDigest !== materialized?.attestationDigest) ||
					!isDigest(appended.attestationDigest) ||
					(appended.previousLedgerDigest !== undefined &&
						!isDigest(appended.previousLedgerDigest)) ||
					(appended.ledgerDigest !== undefined &&
						!isDigest(appended.ledgerDigest)) ||
					(appended.canonicalPayload !== undefined && !persistedPayload)
			) {
				throw new Error("audit unavailable");
			}
			return deepFreeze({
					auditEventId: appended.auditEventId,
					attestationDigest: appended.attestationDigest,
					resultDigest: persistedPayload?.resultDigest ?? resultDigest,
					previousLedgerDigest: appended.previousLedgerDigest ?? "0".repeat(64),
					ledgerDigest: appended.ledgerDigest ?? "0".repeat(64),
					persistedOutcome: persistedPayload?.outcome ?? outcome,
				});
		},
	};
}

function hasAllowedAppendResult(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return (
		["auditEventId", "attestationDigest"].every((key) => keys.includes(key)) &&
		keys.every((key) =>
			[
				"auditEventId",
				"attestationDigest",
				"canonicalPayload",
				"ledgerDigest",
				"previousLedgerDigest",
				"reused",
			].includes(key),
		)
	);
}

function parsePersistedPayload(
	canonicalPayload: string,
): { readonly resultDigest: string; readonly outcome: MagicBlockPersistedAuditOutcome } | null {
	try {
		const parsed = JSON.parse(canonicalPayload) as Record<string, unknown>;
		if (
			canonicalJson(parsed) !== canonicalPayload ||
			!isDigest(parsed.resultDigest) ||
			!["review_required", "incompatible"].includes(String(parsed.outcome))
		) {
			return null;
		}
		return {
			resultDigest: parsed.resultDigest,
			outcome: parsed.outcome as MagicBlockPersistedAuditOutcome,
		};
	} catch {
		return null;
	}
}

function validateEvidence(
	value: unknown,
	resolved: ResolvedTrustedMagicBlockPlan,
): ValidatedMagicBlockEvidence {
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"endpointHost",
			"method",
			"observedAt",
			"accountDigests",
			"classifications",
			"delegationStatuses",
		]) ||
		value.schemaVersion !== "magicblock.devnet-evidence/v1" ||
		value.endpointHost !== MAGICBLOCK_ROUTER_HOST ||
		value.method !== MAGICBLOCK_METHOD ||
		!isCanonicalTimestamp(value.observedAt) ||
		!Array.isArray(value.accountDigests) ||
		!Array.isArray(value.classifications) ||
		!Array.isArray(value.delegationStatuses) ||
		value.accountDigests.length !== resolved.snapshot.accountBindings.length ||
		value.classifications.length !== resolved.snapshot.accountBindings.length ||
		value.delegationStatuses.length !== resolved.snapshot.accountBindings.length
	) {
		throw new Error("audit unavailable");
	}
	const delegationStatuses = [];
	for (let index = 0; index < resolved.snapshot.accountBindings.length; index += 1) {
		const binding = resolved.snapshot.accountBindings[index];
		const status = cloneOfficialDelegationStatus(value.delegationStatuses[index]);
		const expectedClassification = status?.isDelegated ? "delegated" : "base_layer";
		if (
			value.accountDigests[index] !== binding.accountDigest ||
			!["delegated", "base_layer"].includes(value.classifications[index] as string) ||
			status === null ||
			value.classifications[index] !== expectedClassification
		) {
			throw new Error("audit unavailable");
		}
		delegationStatuses.push(status);
	}
	return deepFreeze({
		schemaVersion: "magicblock.devnet-evidence/v1",
		endpointHost: MAGICBLOCK_ROUTER_HOST,
		method: MAGICBLOCK_METHOD,
		observedAt: value.observedAt,
		accountDigests: deepFreeze([...value.accountDigests] as string[]),
		classifications: deepFreeze(
			[...value.classifications] as ("delegated" | "base_layer")[],
		),
		delegationStatuses: deepFreeze(delegationStatuses),
	});
}

export function computeMagicBlockAttestationDigest(
	payload: MagicBlockDevnetAuditPayloadV1,
): string {
	return sha256Hex(ATTESTATION_DOMAIN, canonicalJson(payload));
}
