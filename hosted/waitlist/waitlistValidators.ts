import type { WaitlistRequestValidationResult } from "./waitlistContracts";

// Same shape check as signupValidators: local@domain only, no deliverability/verification.
// A waitlist join stores the address as given; it never proves ownership.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateWaitlistRequest(
	value: unknown,
): WaitlistRequestValidationResult {
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
