import type {
	VerifyConfirmRequest,
	VerifyConfirmRequestValidationResult,
} from "./verifyConfirmContracts";

export function validateVerifyConfirmRequest(
	value: unknown,
): VerifyConfirmRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}
	if (!isNonEmptyString(value.correlationId)) {
		return { ok: false, message: "correlationId is required." };
	}
	if (!isNonEmptyString(value.txSignature)) {
		return { ok: false, message: "txSignature is required." };
	}

	return {
		ok: true,
		request: {
			correlationId: value.correlationId,
			txSignature: value.txSignature,
		} satisfies VerifyConfirmRequest,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
