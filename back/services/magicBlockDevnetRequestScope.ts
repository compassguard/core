import { deepFreeze } from "./magicBlockDevnetPreflightCanonical";
import type { RequestScopedMagicBlockDependencies } from "./magicBlockDevnetObservationContracts";
import type {
	InternalImmutableMagicBlockCandidate,
	TrustedMagicBlockPlanSnapshot,
} from "./magicBlockDevnetPreflightTypes";

export function createRequestScopedMagicBlockDependencies(input: {
	readonly opaqueCandidateRef: string;
	readonly candidate: InternalImmutableMagicBlockCandidate;
}): RequestScopedMagicBlockDependencies {
	const candidateSnapshot = cloneCandidate(input.candidate);
	let storedPlan: TrustedMagicBlockPlanSnapshot | undefined;

	return deepFreeze({
		candidateSource: deepFreeze({
			reference: deepFreeze({
				schemaVersion: "compass.internal-magicblock-candidate-ref/v1",
				opaqueRef: input.opaqueCandidateRef,
			}),
			source: deepFreeze({
				async resolveImmutable(opaqueRef: string) {
					return opaqueRef === input.opaqueCandidateRef
						? cloneCandidate(candidateSnapshot)
						: null;
				},
			}),
		}),
		planStore: deepFreeze({
			async insertImmutable(snapshot: TrustedMagicBlockPlanSnapshot) {
				if (storedPlan) throw new Error("trusted plan unavailable");
				storedPlan = clonePlan(snapshot);
			},
			async resolveImmutable(opaqueRef: string) {
				return storedPlan?.plan.planId === opaqueRef ? clonePlan(storedPlan) : null;
			},
		}),
	});
}

function cloneCandidate(
	candidate: InternalImmutableMagicBlockCandidate,
): InternalImmutableMagicBlockCandidate {
	return deepFreeze({
		schemaVersion: candidate.schemaVersion,
		cluster: candidate.cluster,
		decodedPlan: deepFreeze({
			schemaVersion: candidate.decodedPlan.schemaVersion,
			actionKind: candidate.decodedPlan.actionKind,
			accountIndexes: deepFreeze([...candidate.decodedPlan.accountIndexes]),
		}),
		accounts: deepFreeze(candidate.accounts.map((account) => deepFreeze({ ...account }))),
	});
}

function clonePlan(snapshot: TrustedMagicBlockPlanSnapshot): TrustedMagicBlockPlanSnapshot {
	return deepFreeze({
		schemaVersion: snapshot.schemaVersion,
		plan: deepFreeze({
			...snapshot.plan,
			accountDigests: deepFreeze([...snapshot.plan.accountDigests]),
		}),
		candidate: deepFreeze({
			...snapshot.candidate,
			decodedPlan: deepFreeze({
				...snapshot.candidate.decodedPlan,
				accountIndexes: deepFreeze([...snapshot.candidate.decodedPlan.accountIndexes]),
			}),
			accounts: deepFreeze(
				snapshot.candidate.accounts.map((account) => deepFreeze({ ...account })),
			),
		}),
		accountBindings: deepFreeze(
			snapshot.accountBindings.map((binding) => deepFreeze({ ...binding })),
		),
	});
}
