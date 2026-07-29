import type {
	MagicBlockDevnetPreflightResult,
	ResolvedTrustedMagicBlockPlan,
	TrustedDecodedPlanRef,
	ValidatedMagicBlockEvidence,
} from "./magicBlockDevnetPreflightTypes";

export function createMagicBlockDevnetPreflight(input: {
	readonly enabled?: boolean;
	readonly producer: {
		resolve(reference: TrustedDecodedPlanRef): Promise<ResolvedTrustedMagicBlockPlan>;
	};
	readonly adapter: {
		collect(
			resolved: ResolvedTrustedMagicBlockPlan,
		): Promise<
			| { readonly status: "available"; readonly evidence: ValidatedMagicBlockEvidence }
			| { readonly status: "unavailable" }
		>;
	};
	readonly auditWriter: {
		write(command: {
			readonly resolvedPlan: ResolvedTrustedMagicBlockPlan;
			readonly evidence: ValidatedMagicBlockEvidence;
			readonly observationId?: string;
			readonly transactionDigest?: string;
			readonly requestDigest?: string;
		}): Promise<{
			readonly auditEventId: string;
			readonly attestationDigest: string;
			readonly resultDigest?: string;
			readonly previousLedgerDigest?: string;
			readonly ledgerDigest?: string;
			readonly persistedOutcome?: "review_required" | "incompatible";
		}>;
	};
}) {
	const enabled = input.enabled === true;

	return {
		async review(
			reference: TrustedDecodedPlanRef,
			binding: {
				readonly observationId: string;
				readonly transactionDigest: string;
				readonly requestDigest: string;
			} = {
				observationId: "legacy-observation",
				transactionDigest: "0".repeat(64),
				requestDigest: "0".repeat(64),
			},
		): Promise<MagicBlockDevnetPreflightResult> {
			if (!enabled) return { outcome: "unavailable" };
			try {
				const resolvedPlan = await input.producer.resolve(reference);
				const collected = await input.adapter.collect(resolvedPlan);
				if (collected.status !== "available") return { outcome: "unavailable" };
				const incompatible = collected.evidence.classifications.some(
					(classification) => classification === "base_layer",
				);
				const outcome = incompatible ? "incompatible" : "review_required";
				const audit = await input.auditWriter.write({
					resolvedPlan,
					evidence: collected.evidence,
					...binding,
				});
				return { outcome: audit.persistedOutcome ?? outcome, audit };
			} catch {
				return { outcome: "unavailable" };
			}
		},
	};
}
