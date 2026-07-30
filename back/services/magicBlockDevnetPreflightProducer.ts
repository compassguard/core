import {
	canonicalJson,
	deepFreeze,
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isDigest,
	isOpaqueIdentifier,
	sha256Hex,
} from "./magicBlockDevnetPreflightCanonical";
import type {
	InternalImmutableMagicBlockCandidate,
	InternalMagicBlockCandidateRef,
	InternalMagicBlockCandidateSource,
	MagicBlockAccountProjection,
	MagicBlockDecodedPlan,
	ResolvedTrustedMagicBlockPlan,
	TrustedDecodedActionPlan,
	TrustedDecodedPlanRef,
	TrustedMagicBlockAccountBinding,
	TrustedMagicBlockPlanSnapshot,
	TrustedMagicBlockPlanStore,
} from "./magicBlockDevnetPreflightTypes";
import { MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS } from "./magicBlockDevnetPreflightTypes";

const ACCOUNT_DOMAIN = "compass.magicblock-devnet-preflight/v1/account\0";
const PLAN_DOMAIN = "compass.magicblock-devnet-preflight/v1/decoded-plan\0";

export type MagicBlockOpaqueIdFactory = (kind: "candidate" | "plan") => string;

export function createTrustedMagicBlockPlanProducer(input: {
	readonly candidateSource: InternalMagicBlockCandidateSource;
	readonly store: TrustedMagicBlockPlanStore;
	readonly createOpaqueId: MagicBlockOpaqueIdFactory;
}) {
	return {
		async produce(
			candidateReference: InternalMagicBlockCandidateRef,
		): Promise<TrustedDecodedPlanRef> {
			if (
				!hasExactKeys(candidateReference, ["schemaVersion", "opaqueRef"]) ||
				candidateReference.schemaVersion !==
					"compass.internal-magicblock-candidate-ref/v1" ||
				!isOpaqueIdentifier(candidateReference.opaqueRef)
			) {
				throw new Error("trusted plan unavailable");
			}
			const candidateInput = await input.candidateSource.resolveImmutable(
				candidateReference.opaqueRef,
			);
			if (!candidateInput) throw new Error("trusted plan unavailable");
			const candidateId = input.createOpaqueId("candidate");
			const planId = input.createOpaqueId("plan");
			if (!isOpaqueIdentifier(candidateId) || !isOpaqueIdentifier(planId) || candidateId === planId) {
				throw new Error("trusted plan unavailable");
			}

			const candidate = cloneAndValidateCandidate(candidateInput, candidateId);
			const accountBindings = candidate.accounts.map((account) =>
				deepFreeze({
					...account,
					accountDigest: computeMagicBlockAccountDigest(account),
				}),
			);
			const candidateDigest = computeMagicBlockCandidateDigest(candidate);
			const decodedPlanDigest = computeMagicBlockDecodedPlanDigest(candidate.decodedPlan);
			const plan: TrustedDecodedActionPlan = deepFreeze({
				schemaVersion: "compass.trusted-decoded-action-plan/v1",
				planId,
				candidateId,
				candidateDigest,
				decodedPlanDigest,
				cluster: "devnet",
				accountDigests: accountBindings.map(({ accountDigest }) => accountDigest),
			});
			const snapshot: TrustedMagicBlockPlanSnapshot = deepFreeze({
				schemaVersion: "compass.trusted-decoded-plan-snapshot/v1",
				plan,
				candidate,
				accountBindings,
			});
			await input.store.insertImmutable(snapshot);
			return deepFreeze({
				schemaVersion: "compass.trusted-decoded-plan-ref/v1",
				opaqueRef: planId,
			});
		},

		async resolve(reference: TrustedDecodedPlanRef): Promise<ResolvedTrustedMagicBlockPlan> {
			if (
				!hasExactKeys(reference, ["schemaVersion", "opaqueRef"]) ||
				reference.schemaVersion !== "compass.trusted-decoded-plan-ref/v1" ||
				!isOpaqueIdentifier(reference.opaqueRef)
			) {
				throw new Error("trusted plan unavailable");
			}
			const snapshot = await input.store.resolveImmutable(reference.opaqueRef);
			if (!snapshot || snapshot.plan.planId !== reference.opaqueRef) {
				throw new Error("trusted plan unavailable");
			}
			return verifyResolvedTrustedMagicBlockPlan({ snapshot });
		},
	};
}

export function verifyResolvedTrustedMagicBlockPlan(
	resolved: ResolvedTrustedMagicBlockPlan,
): ResolvedTrustedMagicBlockPlan {
	if (!hasExactKeys(resolved, ["snapshot"])) throw new Error("trusted plan unavailable");
	const snapshot = resolved.snapshot;
	if (
		!hasExactKeys(snapshot, ["schemaVersion", "plan", "candidate", "accountBindings"]) ||
		snapshot.schemaVersion !== "compass.trusted-decoded-plan-snapshot/v1"
	) {
		throw new Error("trusted plan unavailable");
	}

	const plan = snapshot.plan;
	if (
		!hasExactKeys(plan, [
			"schemaVersion",
			"planId",
			"candidateId",
			"candidateDigest",
			"decodedPlanDigest",
			"cluster",
			"accountDigests",
		]) ||
		plan.schemaVersion !== "compass.trusted-decoded-action-plan/v1" ||
		!isOpaqueIdentifier(plan.planId) ||
		!isOpaqueIdentifier(plan.candidateId) ||
		plan.cluster !== "devnet" ||
		!isDigest(plan.candidateDigest) ||
		!isDigest(plan.decodedPlanDigest) ||
		!Array.isArray(plan.accountDigests) ||
		!plan.accountDigests.every(isDigest)
	) {
		throw new Error("trusted plan unavailable");
	}

	const candidate = validateStoredCandidate(snapshot.candidate);
	if (candidate.candidateId !== plan.candidateId || candidate.cluster !== plan.cluster) {
		throw new Error("trusted plan unavailable");
	}
	const bindings = snapshot.accountBindings;
	if (
		!Array.isArray(bindings) ||
		bindings.length !== candidate.accounts.length ||
		plan.accountDigests.length !== candidate.accounts.length
	) {
		throw new Error("trusted plan unavailable");
	}

	for (let index = 0; index < candidate.accounts.length; index += 1) {
		const account = candidate.accounts[index];
		const binding = bindings[index] as TrustedMagicBlockAccountBinding;
		if (
			!hasExactKeys(binding, [
				"accountIndex",
				"publicKey",
				"isSigner",
				"isWritable",
				"isProgram",
				"isPayer",
				"accountDigest",
			]) ||
			binding.accountIndex !== account.accountIndex ||
			binding.publicKey !== account.publicKey ||
			binding.isSigner !== account.isSigner ||
			binding.isWritable !== account.isWritable ||
			binding.isProgram !== account.isProgram ||
			binding.isPayer !== account.isPayer
		) {
			throw new Error("trusted plan unavailable");
		}
		const recomputed = computeMagicBlockAccountDigest(account);
		if (binding.accountDigest !== recomputed || plan.accountDigests[index] !== recomputed) {
			throw new Error("trusted plan unavailable");
		}
	}

	if (
		plan.candidateDigest !== computeMagicBlockCandidateDigest(candidate) ||
		plan.decodedPlanDigest !== computeMagicBlockDecodedPlanDigest(candidate.decodedPlan)
	) {
		throw new Error("trusted plan unavailable");
	}

	return deepFreeze({
		snapshot: deepFreeze({
			schemaVersion: snapshot.schemaVersion,
			plan: deepFreeze({ ...plan, accountDigests: deepFreeze([...plan.accountDigests]) }),
			candidate: deepFreeze({
				...candidate,
				decodedPlan: deepFreeze({
					...candidate.decodedPlan,
					accountIndexes: deepFreeze([...candidate.decodedPlan.accountIndexes]),
				}),
				accounts: deepFreeze(candidate.accounts.map((account) => deepFreeze({ ...account }))),
			}),
			accountBindings: deepFreeze(bindings.map((binding) => deepFreeze({ ...binding }))),
		}),
	});
}

export function computeMagicBlockAccountDigest(account: MagicBlockAccountProjection): string {
	return sha256Hex(ACCOUNT_DOMAIN, canonicalJson(account));
}

export function computeMagicBlockCandidateDigest(candidate: {
	readonly schemaVersion: "compass.magicblock-candidate/v1";
	readonly candidateId: string;
	readonly cluster: "devnet";
	readonly decodedPlan: MagicBlockDecodedPlan;
	readonly accounts: readonly MagicBlockAccountProjection[];
}): string {
	return sha256Hex(canonicalJson(candidate));
}

export function computeMagicBlockDecodedPlanDigest(plan: MagicBlockDecodedPlan): string {
	return sha256Hex(PLAN_DOMAIN, canonicalJson(plan));
}

function cloneAndValidateCandidate(
	value: InternalImmutableMagicBlockCandidate,
	candidateId: string,
): TrustedMagicBlockPlanSnapshot["candidate"] {
	if (
		!hasExactKeys(value, ["schemaVersion", "cluster", "decodedPlan", "accounts"]) ||
		value.schemaVersion !== "compass.magicblock-candidate/v1" ||
		value.cluster !== "devnet" ||
		!Array.isArray(value.accounts) ||
		value.accounts.length === 0 ||
		value.accounts.length > MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS
	) {
		throw new Error("trusted plan unavailable");
	}
	const accounts = value.accounts.map((account, index) => {
		if (
			!hasExactKeys(account, ["publicKey", "isSigner", "isWritable", "isProgram", "isPayer"]) ||
			!isCanonicalSolanaPublicKey(account.publicKey) ||
			typeof account.isSigner !== "boolean" ||
			typeof account.isWritable !== "boolean" ||
			typeof account.isProgram !== "boolean" ||
			typeof account.isPayer !== "boolean"
		) {
			throw new Error("trusted plan unavailable");
		}
		return deepFreeze({
			accountIndex: String(index),
			publicKey: account.publicKey,
			isSigner: account.isSigner,
			isWritable: account.isWritable,
			isProgram: account.isProgram,
			isPayer: account.isPayer,
		});
	});
	const decodedPlan = cloneAndValidateDecodedPlan(value.decodedPlan, accounts.length);
	return deepFreeze({
		schemaVersion: "compass.magicblock-candidate/v1",
		candidateId,
		cluster: "devnet",
		decodedPlan,
		accounts: deepFreeze(accounts),
	});
}

function validateStoredCandidate(value: unknown): TrustedMagicBlockPlanSnapshot["candidate"] {
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"candidateId",
			"cluster",
			"decodedPlan",
			"accounts",
		]) ||
		value.schemaVersion !== "compass.magicblock-candidate/v1" ||
		!isOpaqueIdentifier(value.candidateId) ||
		value.cluster !== "devnet" ||
		!Array.isArray(value.accounts) ||
		value.accounts.length === 0 ||
		value.accounts.length > MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS
	) {
		throw new Error("trusted plan unavailable");
	}
	const accounts = value.accounts.map((account, index) => {
		if (
			!hasExactKeys(account, [
				"accountIndex",
				"publicKey",
				"isSigner",
				"isWritable",
				"isProgram",
				"isPayer",
			]) ||
			account.accountIndex !== String(index) ||
			!isCanonicalSolanaPublicKey(account.publicKey) ||
			typeof account.isSigner !== "boolean" ||
			typeof account.isWritable !== "boolean" ||
			typeof account.isProgram !== "boolean" ||
			typeof account.isPayer !== "boolean"
		) {
			throw new Error("trusted plan unavailable");
		}
		return account as MagicBlockAccountProjection;
	});
	return {
		schemaVersion: "compass.magicblock-candidate/v1",
		candidateId: value.candidateId,
		cluster: "devnet",
		decodedPlan: cloneAndValidateDecodedPlan(value.decodedPlan, accounts.length),
		accounts,
	};
}

function cloneAndValidateDecodedPlan(value: unknown, accountCount: number): MagicBlockDecodedPlan {
	if (
		!hasExactKeys(value, ["schemaVersion", "actionKind", "accountIndexes"]) ||
		value.schemaVersion !== "compass.decoded-action-plan/v1" ||
		value.actionKind !== "account_delegation_review" ||
		!Array.isArray(value.accountIndexes) ||
		value.accountIndexes.length !== accountCount ||
		!value.accountIndexes.every((entry, index) => entry === String(index))
	) {
		throw new Error("trusted plan unavailable");
	}
	return deepFreeze({
		schemaVersion: "compass.decoded-action-plan/v1",
		actionKind: "account_delegation_review",
		accountIndexes: deepFreeze([...value.accountIndexes] as string[]),
	});
}
