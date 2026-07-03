import type { AuditEntry } from "./evaluationContracts";

export const DEFAULT_AUDIT_QUERY_LIMIT = 25;
export const MAX_AUDIT_QUERY_LIMIT = 100;

export type AuditWriteRequest = {
	idempotencyKey: string;
	entry: AuditEntry;
	userId?: string;
	sessionId?: string;
};

export type AuditWriteResponse = {
	auditRef: string;
	correlationId: string;
	idempotencyKey: string;
	created: boolean;
};

export type AuditQueryParams = {
	userId?: string;
	sessionId?: string;
	limit?: number;
};

export type AuditListResponse = {
	audits: AuditEntry[];
};

export type AuditStoreRecord = {
	idempotencyKey: string;
	entry: AuditEntry;
	userId?: string;
	sessionId?: string;
};

export type AuditStore = {
	writeAudit: (request: AuditWriteRequest) => Promise<AuditWriteResponse>;
	listAudits: (query: AuditQueryParams) => Promise<AuditEntry[]>;
	getHealthStatus: () => "ok" | "degraded" | "down";
};

export type AuditWriteValidationResult =
	| { ok: true; request: AuditWriteRequest }
	| { ok: false; message: string };

export type AuditQueryValidationResult =
	| { ok: true; query: AuditQueryParams }
	| { ok: false; message: string };
