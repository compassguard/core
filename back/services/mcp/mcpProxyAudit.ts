/**
 * Proxy audit helper for Wave 11 intercepted downstream calls.
 *
 * Records intent, policy decision, denial reason, forwarding attempt,
 * downstream outcome, and failures without leaking secrets.
 * Audit write failure causes fail-closed denial before forwarding.
 */

import type { ProxyDecision } from "./mcpProxyContracts";

// ---------------------------------------------------------------------------
// Audit event types
// ---------------------------------------------------------------------------

/** Intent event: recorded before forwarding an allowed call. */
export type ProxyAuditIntentEvent = {
	readonly type: "proxy_audit_intent";
	readonly toolName: string;
	readonly policyDecision: ProxyDecision;
	readonly timestamp: string;
	readonly auditId: string;
};

/** Denial event: recorded when a call is denied before forwarding. */
export type ProxyAuditDenialEvent = {
	readonly type: "proxy_audit_denial";
	readonly toolName: string;
	readonly policyDecision: ProxyDecision;
	readonly denialReason: string;
	readonly timestamp: string;
	readonly auditId: string;
};

/** Forwarding outcome event: recorded after downstream response. */
export type ProxyAuditForwardingEvent = {
	readonly type: "proxy_audit_forwarding";
	readonly toolName: string;
	readonly policyDecision: ProxyDecision;
	readonly forwardingOutcome: "success" | "failure";
	readonly timestamp: string;
	readonly auditId: string;
};

/** Audit failure event: recorded when the audit system itself fails. */
export type ProxyAuditFailureEvent = {
	readonly type: "proxy_audit_failure";
	readonly toolName: string;
	readonly error: string;
	readonly timestamp: string;
};

/** Union of all proxy audit event types. */
export type ProxyAuditEvent =
	| ProxyAuditIntentEvent
	| ProxyAuditDenialEvent
	| ProxyAuditForwardingEvent
	| ProxyAuditFailureEvent;

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Patterns that identify secret-bearing argument keys.
 * Values for these keys are redacted in audit output.
 */
const SECRET_ARGUMENT_PATTERNS: readonly RegExp[] = [
	/key/i,
	/secret/i,
	/password/i,
	/token/i,
	/credential/i,
	/auth/i,
	/signer/i,
	/mnemonic/i,
	/private/i,
];

/**
 * Redact secret-bearing arguments from a tool call's arguments before
 * including them in audit output. Returns a sanitized copy.
 */
export function redactSecretArguments(
	arguments_: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!arguments_) {
		return undefined;
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(arguments_)) {
		const isSecret = SECRET_ARGUMENT_PATTERNS.some((pattern) =>
			pattern.test(key),
		);
		redacted[key] = isSecret ? "[REDACTED]" : value;
	}
	return redacted;
}

/**
 * Redact secret-bearing environment variable keys from audit output.
 * Only the key names are preserved; values are never included.
 */
export function redactSecretEnvKeys(
	envKeys: readonly string[],
): readonly string[] {
	return envKeys; // Key names alone are safe; we never include values.
}

// ---------------------------------------------------------------------------
// Audit recording
// ---------------------------------------------------------------------------

/** In-memory audit log for the proxy. Reset between tests or between sessions. */
const proxyAuditEvents: ProxyAuditEvent[] = [];

let auditWriteFailure = false;

/**
 * Record a proxy audit intent event.
 *
 * Returns the audit ID for traceability.
 * If the audit system has been marked as failed, throws to trigger
 * fail-closed behavior.
 */
export function recordProxyAuditIntent(event: {
	toolName: string;
	policyDecision: ProxyDecision;
}): string {
	if (auditWriteFailure) {
		throw new Error(
			"Proxy audit system is in failure state; cannot record intent. " +
				"Denying fail-closed to prevent unaudited forwarding.",
		);
	}

	const auditId = generateAuditId();
	const auditEvent: ProxyAuditIntentEvent = {
		type: "proxy_audit_intent",
		toolName: event.toolName,
		policyDecision: event.policyDecision,
		timestamp: new Date().toISOString(),
		auditId,
	};
	proxyAuditEvents.push(auditEvent);
	return auditId;
}

/**
 * Record a proxy audit denial event.
 *
 * Returns the audit ID for traceability.
 * Denial events are recorded even if the audit system is in a failure state
 * (best-effort), since the call is already being denied.
 */
export function recordProxyAuditDenial(event: {
	toolName: string;
	policyDecision: ProxyDecision;
	denialReason: string;
}): string {
	const auditId = generateAuditId();
	const auditEvent: ProxyAuditDenialEvent = {
		type: "proxy_audit_denial",
		toolName: event.toolName,
		policyDecision: event.policyDecision,
		denialReason: event.denialReason,
		timestamp: new Date().toISOString(),
		auditId,
	};
	proxyAuditEvents.push(auditEvent);
	return auditId;
}

/**
 * Record a proxy audit forwarding outcome event.
 *
 * Returns the audit ID for traceability.
 */
export function recordProxyAuditForwarding(event: {
	toolName: string;
	policyDecision: ProxyDecision;
	forwardingOutcome: "success" | "failure";
	existingAuditId?: string;
}): string {
	const auditId = event.existingAuditId ?? generateAuditId();
	const auditEvent: ProxyAuditForwardingEvent = {
		type: "proxy_audit_forwarding",
		toolName: event.toolName,
		policyDecision: event.policyDecision,
		forwardingOutcome: event.forwardingOutcome,
		timestamp: new Date().toISOString(),
		auditId,
	};
	proxyAuditEvents.push(auditEvent);
	return auditId;
}

/**
 * Record a proxy audit failure event (best-effort, no throw).
 */
export function recordProxyAuditFailure(event: {
	toolName: string;
	error: string;
}): void {
	const auditEvent: ProxyAuditFailureEvent = {
		type: "proxy_audit_failure",
		toolName: event.toolName,
		error: event.error,
		timestamp: new Date().toISOString(),
	};
	// Best-effort: push even if audit is in failure state
	proxyAuditEvents.push(auditEvent);
}

/**
 * List all recorded proxy audit events (for diagnostics and testing).
 */
export function listProxyAuditEvents(): ProxyAuditEvent[] {
	return [...proxyAuditEvents];
}

/**
 * Reset the proxy audit log (for testing).
 */
export function resetProxyAuditEvents(): void {
	proxyAuditEvents.length = 0;
	auditWriteFailure = false;
}

/**
 * Mark the proxy audit system as failed (for testing fail-closed behavior).
 * After calling this, recordProxyAuditIntent will throw, causing
 * the proxy dispatcher to deny calls before forwarding.
 */
export function markProxyAuditFailure(): void {
	auditWriteFailure = true;
}

/**
 * Check whether the proxy audit system is in a failure state.
 */
export function isProxyAuditFailure(): boolean {
	return auditWriteFailure;
}

// ---------------------------------------------------------------------------
// Audit ID generation
// ---------------------------------------------------------------------------

let auditIdCounter = 0;

function generateAuditId(): string {
	auditIdCounter += 1;
	return `proxy-audit-${auditIdCounter.toString().padStart(6, "0")}`;
}