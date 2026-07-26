import {
	MANDATE_MAX_ALLOWED_RECIPIENTS,
	MANDATE_TEXT_MAX_LENGTH,
} from "@shared/mandateContracts";

export type MandatePutRequest = {
	userId?: string;
	mandateText: string;
	allowedRecipients?: string[];
	maxAmountUsd?: number;
};

export type MandatePutRequestValidationResult =
	| { ok: true; request: MandatePutRequest }
	| { ok: false; message: string };

export function validateMandatePutRequest(
	value: unknown,
): MandatePutRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}

	if (!isNonEmptyString(value.mandateText)) {
		return { ok: false, message: "mandateText is required." };
	}
	if (value.mandateText.length > MANDATE_TEXT_MAX_LENGTH) {
		return {
			ok: false,
			message: `mandateText must be at most ${MANDATE_TEXT_MAX_LENGTH} characters.`,
		};
	}

	if (value.userId !== undefined && !isNonEmptyString(value.userId)) {
		return { ok: false, message: "userId must be a non-empty string when provided." };
	}

	if (value.allowedRecipients !== undefined) {
		if (
			!Array.isArray(value.allowedRecipients) ||
			value.allowedRecipients.some((item) => !isNonEmptyString(item))
		) {
			return {
				ok: false,
				message: "allowedRecipients must be an array of non-empty strings when provided.",
			};
		}
		if (value.allowedRecipients.length > MANDATE_MAX_ALLOWED_RECIPIENTS) {
			return {
				ok: false,
				message: `allowedRecipients must have at most ${MANDATE_MAX_ALLOWED_RECIPIENTS} entries.`,
			};
		}
	}

	if (value.maxAmountUsd !== undefined) {
		if (
			typeof value.maxAmountUsd !== "number" ||
			!Number.isFinite(value.maxAmountUsd) ||
			value.maxAmountUsd <= 0
		) {
			return {
				ok: false,
				message: "maxAmountUsd must be a positive finite number when provided.",
			};
		}
	}

	return {
		ok: true,
		request: {
			userId: isNonEmptyString(value.userId) ? value.userId : undefined,
			mandateText: value.mandateText,
			allowedRecipients: value.allowedRecipients as string[] | undefined,
			maxAmountUsd: value.maxAmountUsd as number | undefined,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
