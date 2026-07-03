import {
	HOSTED_CLIENT_ERROR_CODES,
	createHostedClientError,
	type HostedClient,
	type HostedClientConfig,
	validateEvaluateActionResponse,
} from "./mcpHostedClientContracts";
import {
	HOSTED_DECISIONS,
	HOSTED_RISK_LEVELS,
	type EvaluateActionRequest,
	type EvaluateActionResponse,
} from "@shared/evaluationContracts";

const DEFAULT_SUGGESTED_ACTION =
	"Check COMPASS_HOSTED_API_URL, credentials, and hosted health before retrying.";

export function createMcpHostedClient(config: HostedClientConfig): HostedClient {
	const endpointUrl = `${config.url.replace(/\/+$/, "")}/v1/evaluate`;

	return {
		async evaluateAction(request) {
			const controller = new AbortController();
			const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

			try {
				const response = await fetch(endpointUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
						"Content-Type": "application/json",
						"Idempotency-Key": request.idempotencyKey,
					},
					body: JSON.stringify(request),
					signal: controller.signal,
				});

				if (!response.ok) {
					return buildFailClosedResponse(
						request,
						response.status === 401 || response.status === 403
							? createHostedClientError(
									HOSTED_CLIENT_ERROR_CODES.UNAUTHORIZED,
									`Hosted evaluation rejected credentials with status ${response.status}.`,
									{ status: response.status },
							  )
							: createHostedClientError(
									HOSTED_CLIENT_ERROR_CODES.HTTP_ERROR,
									`Hosted evaluation failed with status ${response.status}.`,
									{ status: response.status },
							  ),
					);
				}

				const body = await parseJson(response);
				const validation = validateEvaluateActionResponse(body);
				if (validation.ok) {
					return validation.response;
				}

				if (!("error" in validation)) {
					return buildFailClosedResponse(
						request,
						createHostedClientError(
							HOSTED_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
							"Hosted evaluation response failed validation.",
						),
					);
				}

				const validationError = validation.error;
				return buildFailClosedResponse(request, validationError);
			} catch (error) {
				return buildFailClosedResponse(
					request,
					isHostedClientLikeError(error)
						? error
						: mapFetchError(error, config.timeoutMs),
				);
			} finally {
				clearTimeout(timeoutHandle);
			}
		},
	};
}

async function parseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw createHostedClientError(
			HOSTED_CLIENT_ERROR_CODES.INVALID_JSON,
			"Hosted evaluation returned invalid JSON.",
			{ cause: error },
		);
	}
}

function mapFetchError(error: unknown, timeoutMs: number) {
	if (isAbortError(error)) {
		return createHostedClientError(
			HOSTED_CLIENT_ERROR_CODES.TIMEOUT,
			`Hosted evaluation timed out after ${timeoutMs}ms; denying fail-closed.`,
			{ cause: error },
		);
	}

	return createHostedClientError(
		HOSTED_CLIENT_ERROR_CODES.NETWORK_ERROR,
		"Hosted evaluation request failed; denying fail-closed.",
		{ cause: error },
	);
}

function buildFailClosedResponse(
	request: EvaluateActionRequest,
	error: { code: string; message: string },
): EvaluateActionResponse {
	return {
		correlationId: request.correlationId,
		decision: HOSTED_DECISIONS.DENY,
		riskLevel: HOSTED_RISK_LEVELS.HIGH,
		reasons: [`HOSTED_${error.code}`],
		suggestedAction: DEFAULT_SUGGESTED_ACTION,
		auditRef: `local_fail_closed_${request.correlationId}`,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && error.name === "AbortError";
}

function isHostedClientLikeError(
	error: unknown,
): error is { code: string; message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string" &&
		"message" in error
	);
}
