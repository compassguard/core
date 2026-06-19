import type { AuditEvent } from "@shared/executionGatewayContracts";

const mcpAuditEvents: AuditEvent[] = [];

export function recordMcpAuditEvent(event: AuditEvent): string {
	mcpAuditEvents.push(event);
	return event.id;
}

export function listMcpAuditEvents(): AuditEvent[] {
	return [...mcpAuditEvents];
}

export function resetMcpAuditEvents(): void {
	mcpAuditEvents.length = 0;
}
