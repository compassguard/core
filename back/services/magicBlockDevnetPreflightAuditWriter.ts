import {
	canonicalJson,
	deepFreeze,
	hasExactKeys,
	isCanonicalTimestamp,
	isDigest,
	sha256Hex,
} from "./magicBlockDevnetPreflightCanonical";
import { verifyResolvedTrustedMagicBlockPlan } from "./magicBlockDevnetPreflightProducer";
import {
	MAGICBLOCK_AS_HOST,
	MAGICBLOCK_METHOD,
	MAGICBLOCK_ROUTER_HOST,
	type DelegationRecordV1,
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
const DECIMAL = /^(?:0|[1-9]\d*)$/;
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
		}): Promise<MagicBlockAuditWriteResult> {
			if (
				!hasExactKeys(command, ["resolvedPlan", "evidence"])
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
			const occurredAt = now();
			if (!isCanonicalTimestamp(occurredAt)) throw new Error("audit unavailable");
			const safeCommand = deepFreeze({
				candidateDigest: resolved.snapshot.plan.candidateDigest,
				decodedPlanDigest: resolved.snapshot.plan.decodedPlanDigest,
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
						occurredAt: safeCommand.occurredAt,
						cluster: "devnet",
						candidateDigest: safeCommand.candidateDigest,
						decodedPlanDigest: safeCommand.decodedPlanDigest,
						evidence: safeCommand.evidence,
						outcome: safeCommand.outcome,
						rationaleCode: safeCommand.rationaleCode,
						registration: "not_requested",
					});
					const canonicalPayload = canonicalJson(payload);
					const attestationDigest = sha256Hex(ATTESTATION_DOMAIN, canonicalPayload);
					materialized = { auditEventId, attestationDigest };
					return { payload, canonicalPayload, attestationDigest };
				},
			});
			if (
				materializeCount !== 1 ||
				!materialized ||
				!hasExactKeys(appended, ["auditEventId", "attestationDigest"]) ||
				appended.auditEventId !== materialized.auditEventId ||
				appended.attestationDigest !== materialized.attestationDigest ||
				!isDigest(appended.attestationDigest)
			) {
				throw new Error("audit unavailable");
			}
			return deepFreeze({
				auditEventId: appended.auditEventId,
				attestationDigest: appended.attestationDigest,
			});
		},
	};
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
			"delegationRecords",
		]) ||
		value.schemaVersion !== "magicblock.devnet-evidence/v1" ||
		value.endpointHost !== MAGICBLOCK_ROUTER_HOST ||
		value.method !== MAGICBLOCK_METHOD ||
		!isCanonicalTimestamp(value.observedAt) ||
		!Array.isArray(value.accountDigests) ||
		!Array.isArray(value.classifications) ||
		!Array.isArray(value.delegationRecords) ||
		value.accountDigests.length !== resolved.snapshot.accountBindings.length ||
		value.classifications.length !== resolved.snapshot.accountBindings.length ||
		value.delegationRecords.length !== resolved.snapshot.accountBindings.length
	) {
		throw new Error("audit unavailable");
	}
	for (let index = 0; index < resolved.snapshot.accountBindings.length; index += 1) {
		const binding = resolved.snapshot.accountBindings[index];
		const record = value.delegationRecords[index] as DelegationRecordV1;
		if (
			value.accountDigests[index] !== binding.accountDigest ||
			!["delegated", "base_layer"].includes(value.classifications[index] as string) ||
			value.classifications[index] !== record?.status ||
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
			record.candidateId !== resolved.snapshot.plan.candidateId ||
			record.candidateDigest !== resolved.snapshot.plan.candidateDigest ||
			record.accountDigest !== binding.accountDigest ||
			!["delegated", "base_layer"].includes(record.status) ||
			typeof record.evaluatedSlot !== "string" ||
			!DECIMAL.test(record.evaluatedSlot) ||
			!["processed", "confirmed", "finalized"].includes(record.commitment) ||
			!hasExactKeys(record.evidence, ["endpointHost"]) ||
			record.evidence.endpointHost !== MAGICBLOCK_AS_HOST
		) {
			throw new Error("audit unavailable");
		}
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
		delegationRecords: deepFreeze(
			value.delegationRecords.map((record) =>
				deepFreeze({
					...record,
					evidence: deepFreeze({ ...record.evidence }),
				}),
			),
		),
	});
}

export function computeMagicBlockAttestationDigest(
	payload: MagicBlockDevnetAuditPayloadV1,
): string {
	return sha256Hex(ATTESTATION_DOMAIN, canonicalJson(payload));
}
