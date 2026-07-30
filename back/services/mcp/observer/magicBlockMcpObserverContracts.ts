export const MAGICBLOCK_MCP_AUDIT_PATH =
	"/api/magicblock-devnet/audit" as const;
export const MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES = 16_384 as const;
export const MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES = 32_768 as const;
export const MAGICBLOCK_MCP_AUDIT_DEFAULT_TIMEOUT_MS = 20_000 as const;
export const MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS = 45_000 as const;

export type MagicBlockMcpObservation = {
	readonly schemaVersion: "compass.magicblock-devnet-observation/v1";
	readonly observationId: string;
	readonly unsignedTransactionBase64: string;
};

export type MagicBlockMcpAuditDiagnostic =
	| {
			readonly outcome: "confirmed";
			readonly status: number;
			readonly audit: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly outcome: "retryable_failure";
			readonly retryable: true;
			readonly code: "AUDIT_TIMEOUT" | "AUDIT_UNAVAILABLE" | "AUDIT_REJECTED";
			readonly status?: number;
	  };

export type MagicBlockMcpAuditTransport = (
	url: string,
	init: {
		readonly method: "POST";
		readonly redirect: "error";
		readonly headers: Readonly<{
			Authorization: string;
			"Content-Type": "application/json";
		}>;
		readonly body: string;
		readonly signal: AbortSignal;
	},
) => Promise<{
	readonly status: number;
	readonly body?: ReadableStream<Uint8Array> | null;
	json?(): Promise<unknown>;
}>;

export type MagicBlockMcpAuditClient = {
	observe(
		observation: MagicBlockMcpObservation,
	): Promise<MagicBlockMcpAuditDiagnostic>;
};

export type MagicBlockMcpObserver = (
	observation: MagicBlockMcpObservation,
) => MagicBlockMcpAuditDiagnostic | PromiseLike<MagicBlockMcpAuditDiagnostic>;

export type MagicBlockMcpObserverRuntimeConfig =
	| { readonly enabled: false }
	| {
			readonly enabled: true;
			readonly url: string;
			readonly apiKey: string;
			readonly timeoutMs: number;
	  };
