import { randomUUID } from "node:crypto";

import type {
	AuditQueryParams,
	AuditStore,
	AuditStoreRecord,
	AuditWriteRequest,
	AuditWriteResponse,
} from "./auditContracts";

export function createInMemoryAuditStore(): AuditStore {
	const records = new Map<string, AuditStoreRecord>();

	return {
		async writeAudit(request: AuditWriteRequest): Promise<AuditWriteResponse> {
			const existing = records.get(request.entry.correlationId);
			if (existing) {
				return {
					auditRef: existing.entry.auditRef,
					correlationId: existing.entry.correlationId,
					idempotencyKey: existing.idempotencyKey,
					created: false,
				};
			}

			const entry = request.entry.auditRef
				? request.entry
				: { ...request.entry, auditRef: `aud_${randomUUID()}` };
			records.set(entry.correlationId, {
				idempotencyKey: request.idempotencyKey,
				entry,
				userId: request.userId,
				sessionId: request.sessionId,
			});

			return {
				auditRef: entry.auditRef,
				correlationId: entry.correlationId,
				idempotencyKey: request.idempotencyKey,
				created: true,
			};
		},

		async listAudits(query: AuditQueryParams) {
			const matches = [...records.values()].filter((record) => {
				if (query.userId) {
					return record.userId === query.userId;
				}

				if (query.sessionId) {
					return record.sessionId === query.sessionId;
				}

				return false;
			});

			const limit = query.limit ?? matches.length;
			return matches
				.slice()
				.reverse()
				.slice(0, limit)
				.map((record) => record.entry);
		},

		getHealthStatus() {
			return "ok";
		},
	};
}
