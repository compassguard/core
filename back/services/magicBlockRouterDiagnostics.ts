import {
	MAGICBLOCK_RPC_METHODS,
	type MagicBlockRouterDiagnostics,
	type MagicBlockRpcMethod,
} from "./magicBlockOnchainAuditContracts";

const MAX_MESSAGE_LENGTH = 240;
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;
const SENSITIVE_DETAIL =
	/\b(?:data|logs?|memo|private|request(?:\s+body)?|secret|serialized|transaction)\s*[:=]/i;

export class MagicBlockRouterRpcError extends Error {
	readonly diagnostics: MagicBlockRouterDiagnostics;
	readonly preflightRejected: boolean;

	constructor(
		diagnostics: MagicBlockRouterDiagnostics,
		preflightRejected: boolean,
	) {
		super(
			preflightRejected
				? "Magic Router preflight rejected"
				: "Magic Router unavailable",
		);
		this.name = "MagicBlockRouterRpcError";
		this.diagnostics = diagnostics;
		this.preflightRejected = preflightRejected;
	}
}

export function createMagicBlockRouterDiagnostics(input: {
	readonly rpcMethod: unknown;
	readonly httpStatus?: unknown;
	readonly rpcErrorCode?: unknown;
	readonly message?: unknown;
	readonly requestId?: unknown;
}): MagicBlockRouterDiagnostics | undefined {
	if (
		typeof input.rpcMethod !== "string" ||
		!MAGICBLOCK_RPC_METHODS.includes(input.rpcMethod as MagicBlockRpcMethod)
	) {
		return undefined;
	}
	const httpStatus =
		Number.isSafeInteger(input.httpStatus) &&
		Number(input.httpStatus) >= 100 &&
		Number(input.httpStatus) <= 599
			? Number(input.httpStatus)
			: undefined;
	const rpcErrorCode = Number.isSafeInteger(input.rpcErrorCode)
		? Number(input.rpcErrorCode)
		: undefined;
	const message = sanitizeMagicBlockRouterMessage(input.message);
	const requestId = sanitizeMagicBlockRouterRequestId(input.requestId);
	return Object.freeze({
		rpcMethod: input.rpcMethod as MagicBlockRouterDiagnostics["rpcMethod"],
		...(httpStatus !== undefined ? { httpStatus } : {}),
		...(rpcErrorCode !== undefined ? { rpcErrorCode } : {}),
		...(message !== undefined ? { message } : {}),
		...(requestId !== undefined ? { requestId } : {}),
	});
}

export function isMagicBlockRouterDiagnostics(
	value: unknown,
): value is MagicBlockRouterDiagnostics {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	const sanitized = createMagicBlockRouterDiagnostics({
		rpcMethod: record.rpcMethod,
		httpStatus: record.httpStatus,
		rpcErrorCode: record.rpcErrorCode,
		message: record.message,
		requestId: record.requestId,
	});
	return (
		sanitized !== undefined &&
		keys.includes("rpcMethod") &&
		keys.every((key) =>
			[
				"httpStatus",
				"message",
				"requestId",
				"rpcErrorCode",
				"rpcMethod",
			].includes(key),
		) &&
		keys.every(
			(key) =>
				record[key] ===
				(sanitized as Readonly<Record<string, unknown>>)[key],
		)
	);
}

export function sanitizeMagicBlockRouterMessage(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	let message = value
		.replace(/[^\x20-\x7e]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (message === "") return undefined;
	message = message
		.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
		.replace(/compass:audit:v1:[^\s"'<>]*/gi, "[redacted]")
		.replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted]");
	const sensitiveDetailIndex = message.search(SENSITIVE_DETAIL);
	if (sensitiveDetailIndex >= 0) {
		message = `${message.slice(0, sensitiveDetailIndex).trim()} [details redacted]`.trim();
	}
	if (message === "" || message === "[details redacted]") {
		message = "Magic Router rejected request [details redacted]";
	}
	return message.slice(0, MAX_MESSAGE_LENGTH).trim();
}

export function isMagicBlockRouterPreflightRejection(
	diagnostics: MagicBlockRouterDiagnostics,
): boolean {
	return (
		diagnostics.rpcMethod === "sendTransaction" &&
		(diagnostics.rpcErrorCode === -32002 ||
			/(?:blockhash not found|preflight|simulation failed)/i.test(
				diagnostics.message ?? "",
			))
	);
}

function sanitizeMagicBlockRouterRequestId(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const requestId = value.trim();
	return requestId.length >= 1 &&
		requestId.length <= MAX_REQUEST_ID_LENGTH &&
		SAFE_REQUEST_ID.test(requestId)
		? requestId
		: undefined;
}
