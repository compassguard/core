export const MAGICBLOCK_MCP_AUDIT_PATH =
	"/api/magicblock-devnet/audit" as const;
export const MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES = 16_384 as const;
export const MAGICBLOCK_MCP_AUDIT_DEFAULT_TIMEOUT_MS = 500 as const;
export const MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS = 1_000 as const;

export type MagicBlockMcpObservation = {
	readonly schemaVersion: "compass.magicblock-devnet-observation/v1";
	readonly observationId: string;
	readonly unsignedTransactionBase64: string;
};

export type MagicBlockMcpAuditDiagnostic =
	| { readonly outcome: "delivered"; readonly status: number }
	| { readonly outcome: "rejected"; readonly status: number }
	| { readonly outcome: "timeout" }
	| { readonly outcome: "transport_error" };

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
) => Promise<{ readonly status: number }>;

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
