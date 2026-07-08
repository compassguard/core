import type { SignupRequestValidationResult } from "./signupContracts";

// Basic local@domain shape only — NOT deliverability/verification (D15, explicitly out of scope):
// an open signup mints a credential for any well-formed address without ownership proof (the
// documented stub). This guards only against an obviously non-email value.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignupRequest(
	value: unknown,
): SignupRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}

	if (!isNonEmptyString(value.email)) {
		return { ok: false, message: "email is required." };
	}

	if (!EMAIL_SHAPE.test(value.email)) {
		return { ok: false, message: "email must be a valid email address." };
	}

	return { ok: true, request: { email: value.email } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
