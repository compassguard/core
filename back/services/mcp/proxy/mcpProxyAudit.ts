/**
 * Test-only local proxy diagnostics.
 *
 * Hosted audit is authoritative. This module stays only as an in-memory sink
 * for tests that want to assert locally captured diagnostics.
 */

export type ProxyAuditEvent = {
	readonly type: string;
	readonly timestamp: string;
	readonly [key: string]: unknown;
};

const proxyAuditEvents: ProxyAuditEvent[] = [];

export function appendProxyAuditEvent(event: {
	type: string;
	readonly [key: string]: unknown;
}): void {
	proxyAuditEvents.push({
		...event,
		timestamp: new Date().toISOString(),
	});
}

export function listProxyAuditEvents(): ProxyAuditEvent[] {
	return [...proxyAuditEvents];
}

export function resetProxyAuditEvents(): void {
	proxyAuditEvents.length = 0;
}
