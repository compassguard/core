import {
	deepFreeze,
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isPlainRecord,
} from "./magicBlockDevnetPreflightCanonical";
import type {
	MagicBlockDelegationRecord,
	MagicBlockDelegationStatus,
} from "./magicBlockDevnetPreflightTypes";

const MAX_FQDN_LENGTH = 2_048;

export function cloneOfficialDelegationStatus(
	value: unknown,
): MagicBlockDelegationStatus | null {
	if (!isPlainRecord(value)) return null;
	const keys = Object.keys(value);
	if (
		!Object.hasOwn(value, "isDelegated") ||
		keys.some(
			(key) => !["isDelegated", "fqdn", "delegationRecord"].includes(key),
		) ||
		typeof value.isDelegated !== "boolean"
	) {
		return null;
	}
	const fqdn = value.fqdn;
	let validatedFqdn: string | undefined;
	if (fqdn !== undefined) {
		if (
			typeof fqdn !== "string" ||
			fqdn.length === 0 ||
			fqdn.length > MAX_FQDN_LENGTH ||
			[...fqdn].some((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code <= 0x1f || code === 0x7f;
			})
		) {
			return null;
		}
		validatedFqdn = fqdn;
	}
	const delegationRecord =
		value.delegationRecord === undefined
			? undefined
			: cloneOfficialDelegationRecord(value.delegationRecord);
	if (value.delegationRecord !== undefined && !delegationRecord) return null;
	return deepFreeze({
		isDelegated: value.isDelegated,
		...(validatedFqdn === undefined ? {} : { fqdn: validatedFqdn }),
		...(delegationRecord === undefined ? {} : { delegationRecord }),
	});
}

function cloneOfficialDelegationRecord(
	value: unknown,
): MagicBlockDelegationRecord | null {
	if (
		!hasExactKeys(value, ["authority", "owner", "delegationSlot", "lamports"]) ||
		!isCanonicalSolanaPublicKey(value.authority) ||
		!isCanonicalSolanaPublicKey(value.owner) ||
		typeof value.delegationSlot !== "number" ||
		!Number.isSafeInteger(value.delegationSlot) ||
		value.delegationSlot < 0 ||
		typeof value.lamports !== "number" ||
		!Number.isSafeInteger(value.lamports) ||
		value.lamports < 0
	) {
		return null;
	}
	return deepFreeze({
		authority: value.authority,
		owner: value.owner,
		delegationSlot: value.delegationSlot,
		lamports: value.lamports,
	});
}
