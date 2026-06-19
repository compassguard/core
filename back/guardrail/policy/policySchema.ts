import {
	POLICY_OUTCOMES,
	type CompassPolicy,
	type PolicyValidationError,
	type PolicyValidationResult,
} from "@shared/policyContracts";

const POLICY_OUTCOME_VALUES = new Set<string>(Object.values(POLICY_OUTCOMES));

export function validateCompassPolicy(input: unknown): PolicyValidationResult {
	const errors: PolicyValidationError[] = [];

	if (!isPlainRecord(input)) {
		return {
			ok: false,
			errors: [{ path: "policy", message: "policy object is required" }],
		};
	}

	requireString(input, "policy_id", errors);
	requireString(input, "version", errors);
	requirePolicyOutcome(input, "default", errors);

	const readOnly = requireRecord(input, "read_only", errors) ?? {};
	requirePolicyOutcome(readOnly, "read_only.default", errors, "default");

	const transfers = requireRecord(input, "transfers", errors) ?? {};
	requireNumber(
		transfers,
		"transfers.max_usd_without_approval",
		errors,
		"max_usd_without_approval",
	);
	requireBoolean(
		transfers,
		"transfers.require_approval_for_unknown_recipient",
		errors,
		"require_approval_for_unknown_recipient",
	);
	requireStringArray(
		transfers,
		"transfers.blocked_recipients",
		errors,
		"blocked_recipients",
	);

	const swaps = requireRecord(input, "swaps", errors) ?? {};
	requireNumber(
		swaps,
		"swaps.max_usd_without_approval",
		errors,
		"max_usd_without_approval",
	);
	requireNumber(swaps, "swaps.max_slippage_bps", errors, "max_slippage_bps");
	requireBoolean(
		swaps,
		"swaps.require_approval_for_unknown_token",
		errors,
		"require_approval_for_unknown_token",
	);
	requireStringArray(
		swaps,
		"swaps.allowed_protocols",
		errors,
		"allowed_protocols",
	);

	const conditionalBuys = requireRecord(input, "conditional_buys", errors) ?? {};
	requirePolicyOutcome(
		conditionalBuys,
		"conditional_buys.default",
		errors,
		"default",
	);
	requireNumber(
		conditionalBuys,
		"conditional_buys.max_slippage_bps",
		errors,
		"max_slippage_bps",
	);
	requireNumber(
		conditionalBuys,
		"conditional_buys.max_oracle_age_seconds",
		errors,
		"max_oracle_age_seconds",
	);
	requireNumber(
		conditionalBuys,
		"conditional_buys.max_confidence_bps",
		errors,
		"max_confidence_bps",
	);

	const signing = requireRecord(input, "signing", errors) ?? {};
	requirePolicyOutcome(signing, "signing.sign_message", errors, "sign_message");
	requirePolicyOutcome(
		signing,
		"signing.sign_transaction",
		errors,
		"sign_transaction",
	);
	requirePolicyOutcome(
		signing,
		"signing.sign_and_send_transaction",
		errors,
		"sign_and_send_transaction",
	);

	const blocked = requireRecord(input, "blocked", errors) ?? {};
	requirePolicyOutcome(
		blocked,
		"blocked.unknown_program",
		errors,
		"unknown_program",
	);
	requirePolicyOutcome(
		blocked,
		"blocked.unlimited_delegate",
		errors,
		"unlimited_delegate",
	);
	requirePolicyOutcome(
		blocked,
		"blocked.authority_change",
		errors,
		"authority_change",
	);
	requirePolicyOutcome(
		blocked,
		"blocked.suspicious_recipient",
		errors,
		"suspicious_recipient",
	);

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, policy: input as CompassPolicy };
}

function requireRecord(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): Record<string, unknown> | undefined {
	const value = record[key];
	if (isPlainRecord(value)) {
		return value;
	}

	errors.push({ path, message: "required object" });
	return undefined;
}

function requireString(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): void {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		errors.push({ path, message: "required string" });
	}
}

function requireNumber(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): void {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push({ path, message: "required number" });
	}
}

function requireBoolean(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): void {
	const value = record[key];
	if (typeof value !== "boolean") {
		errors.push({ path, message: "required boolean" });
	}
}

function requireStringArray(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): void {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		errors.push({ path, message: "required string array" });
	}
}

function requirePolicyOutcome(
	record: Record<string, unknown>,
	path: string,
	errors: PolicyValidationError[],
	key = path,
): void {
	const value = record[key];
	if (typeof value !== "string") {
		errors.push({ path, message: "required policy outcome" });
		return;
	}

	if (!POLICY_OUTCOME_VALUES.has(value)) {
		errors.push({
			path,
			message: "Invalid policy outcome",
		});
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
