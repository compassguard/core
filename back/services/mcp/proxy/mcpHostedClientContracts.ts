import {
	isHostedDecision,
	isHostedRiskLevel,
	type EvaluateActionRequest,
	type EvaluateActionResponse,
} from "@shared/evaluationContracts";

export type HostedClientConfig = {
	url: string;
	apiKey: string;
	timeoutMs: number;
};

export type HostedClient = {
	evaluateAction: (
		request: EvaluateActionRequest,
	) => Promise<EvaluateActionResponse>;
};

export const HOSTED_CLIENT_ERROR_CODES = {
	TIMEOUT: "TIMEOUT",
	NETWORK_ERROR: "NETWORK_ERROR",
	HTTP_ERROR: "HTTP_ERROR",
	INVALID_JSON: "INVALID_JSON",
	MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
	UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type HostedClientErrorCode =
	(typeof HOSTED_CLIENT_ERROR_CODES)[keyof typeof HOSTED_CLIENT_ERROR_CODES];

export type HostedClientError = {
	code: HostedClientErrorCode;
	message: string;
	status?: number;
	cause?: unknown;
};

export type HostedResponseValidationResult =
	| {
		ok: true;
		response: EvaluateActionResponse;
	  }
	| {
		ok: false;
		error: HostedClientError;
	  };

export function createHostedClientError(
	code: HostedClientErrorCode,
	message: string,
	extra: Pick<HostedClientError, "status" | "cause"> = {},
): HostedClientError {
	return {
		code,
		message,
		...extra,
	};
}

export function validateEvaluateActionResponse(
	value: unknown,
): HostedResponseValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response must be a JSON object.",
			),
		};
	}

	if (!isNonEmptyString(value.correlationId)) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response is missing a valid correlationId.",
			),
		};
	}

	if (!isHostedDecision(value.decision)) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response is missing a valid decision.",
			),
		};
	}

	if (!isHostedRiskLevel(value.riskLevel)) {
		return {
			ok: false,
				error: createHostedClientError(
					HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
					"Hosted evaluation response is missing a valid riskLevel.",
				),
			};
	}

	if (!Array.isArray(value.reasons) || !value.reasons.every(isNonEmptyString)) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response is missing valid reasons.",
			),
		};
	}

	if (!isNonEmptyString(value.auditRef)) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response is missing a valid auditRef.",
			),
		};
	}

	if (
		value.suggestedAction !== undefined &&
		!isNonEmptyString(value.suggestedAction)
	) {
		return {
			ok: false,
			error: createHostedClientError(
				HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
				"Hosted evaluation response has an invalid suggestedAction.",
			),
		};
	}

	const suggestedAction = isNonEmptyString(value.suggestedAction)
		? value.suggestedAction
		: undefined;

	return {
		ok: true,
		response: {
			correlationId: value.correlationId,
			decision: value.decision,
			riskLevel: value.riskLevel,
			reasons: value.reasons,
			suggestedAction,
			auditRef: value.auditRef,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
