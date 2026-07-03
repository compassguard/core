import type {
	VerifyActionRequest,
	VerifyActionRequestValidationResult,
} from "./verifyContracts";

export function validateVerifyActionRequest(
	value: unknown,
): VerifyActionRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}

	if (!isNonEmptyString(value.toolName)) {
		return { ok: false, message: "toolName is required." };
	}

	if (value.arguments !== undefined && !isRecord(value.arguments)) {
		return { ok: false, message: "arguments must be an object when provided." };
	}

	if (value.intent !== undefined) {
		if (!isRecord(value.intent)) {
			return { ok: false, message: "intent must be an object when provided." };
		}
		if (value.intent.kind !== "transfer" && value.intent.kind !== "swap") {
			return {
				ok: false,
				message: 'intent.kind must be "transfer" or "swap".',
			};
		}
	}

	return {
		ok: true,
		request: {
			toolName: value.toolName,
			arguments: value.arguments as Record<string, unknown> | undefined,
			intent: value.intent as VerifyActionRequest["intent"],
			requestedAt: isNonEmptyString(value.requestedAt)
				? value.requestedAt
				: undefined,
			userId: isNonEmptyString(value.userId) ? value.userId : undefined,
			sessionId: isNonEmptyString(value.sessionId) ? value.sessionId : undefined,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
