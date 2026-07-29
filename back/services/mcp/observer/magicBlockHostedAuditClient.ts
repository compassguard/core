import {
	MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES,
	MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES,
	MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS,
	type MagicBlockMcpAuditClient,
	type MagicBlockMcpAuditTransport,
} from "./magicBlockMcpObserverContracts";
import {
	isSafeAuditApiKey,
	isSafeAuditUrl,
} from "./magicBlockMcpObserverConfig";
import {
	canonicalJson,
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isCanonicalTimestamp,
	isDigest,
	isOpaqueIdentifier,
} from "../../magicBlockDevnetPreflightCanonical";

export function createMagicBlockHostedAuditClient(input: {
	readonly url: string;
	readonly apiKey: string;
	readonly timeoutMs: number;
	readonly transport?: MagicBlockMcpAuditTransport;
}): MagicBlockMcpAuditClient {
	if (
		!isSafeAuditUrl(input.url) ||
		!isSafeAuditApiKey(input.apiKey) ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs <= 0 ||
		input.timeoutMs > MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS
	) {
		throw new Error("MagicBlock MCP audit client unavailable");
	}
	const transport =
		input.transport ??
		((url, init) =>
			globalThis.fetch(url, init) as Promise<{
				readonly status: number;
				readonly body: ReadableStream<Uint8Array> | null;
				json(): Promise<unknown>;
			}>);

	return {
		async observe(observation) {
			const body = JSON.stringify(observation);
			if (
				new TextEncoder().encode(body).byteLength >
				MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES
			) {
				return { outcome: "retryable_failure", retryable: true, code: "AUDIT_UNAVAILABLE" };
			}

			const controller = new AbortController();
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => {
					controller.abort();
					resolve("timeout");
				}, input.timeoutMs);
			});
			const operation = Promise.resolve().then(async () => {
				const response = await transport(input.url, {
					method: "POST",
					redirect: "error",
					headers: {
						Authorization: `Bearer ${input.apiKey}`,
						"Content-Type": "application/json",
					},
					body,
					signal: controller.signal,
				});
				if (
					!Number.isInteger(response.status) ||
					response.status < 100 ||
					response.status > 599
				) {
					return { outcome: "retryable_failure" as const, retryable: true as const, code: "AUDIT_UNAVAILABLE" as const };
				}
				if (response.status < 200 || response.status >= 300) {
					return {
						outcome: "retryable_failure" as const,
						retryable: true as const,
						code: "AUDIT_REJECTED" as const,
						status: response.status,
					};
				}
				let responseBody: unknown;
				try {
					responseBody = await readBoundedJson(response);
				} catch {
					return {
						outcome: "retryable_failure" as const,
						retryable: true as const,
						code: "AUDIT_UNAVAILABLE" as const,
						status: response.status,
					};
				}
				if (!isConfirmedAuditResult(responseBody, observation.observationId)) {
					return {
						outcome: "retryable_failure" as const,
						retryable: true as const,
						code: "AUDIT_UNAVAILABLE" as const,
						status: response.status,
					};
				}
				return {
					outcome: "confirmed" as const,
					status: response.status,
					audit: responseBody,
				};
			});

			try {
				const settled = await Promise.race([
					operation.then(
						(value) => ({ kind: "result" as const, value }),
						() => ({ kind: "error" as const }),
					),
					timeout,
				]);
				if (settled === "timeout") {
					return { outcome: "retryable_failure", retryable: true, code: "AUDIT_TIMEOUT" };
				}
				if (settled.kind === "error") {
					return { outcome: "retryable_failure", retryable: true, code: "AUDIT_UNAVAILABLE" };
				}
				return settled.value;
			} finally {
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			}
		},
	};
}

async function readBoundedJson(response: {
	readonly body?: ReadableStream<Uint8Array> | null;
	json?(): Promise<unknown>;
}): Promise<unknown> {
	if (!response.body) {
		const value = await response.json?.();
		const encoded = JSON.stringify(value);
		if (
			encoded === undefined ||
			new TextEncoder().encode(encoded).byteLength >
				MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES
		) {
			throw new Error("audit response unavailable");
		}
		return value;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAGICBLOCK_MCP_AUDIT_MAX_RESPONSE_BYTES) {
				await reader.cancel("audit response exceeds limit").catch(() => undefined);
				throw new Error("audit response unavailable");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isConfirmedAuditResult(
	value: unknown,
	observationId: string,
): value is Readonly<Record<string, unknown>> {
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"observationId",
			"outcome",
			"audit",
		]) ||
		value.schemaVersion !== "compass.magicblock-devnet-observation-result/v1" ||
		value.observationId !== observationId ||
		!["review_required", "incompatible"].includes(String(value.outcome)) ||
		!hasExactKeys(value.audit, [
			"auditEventId",
			"attestationDigest",
			"resultDigest",
			"previousLedgerDigest",
			"ledgerDigest",
			"registration",
		]) ||
		!isOpaqueIdentifier(value.audit.auditEventId) ||
		!isDigest(value.audit.attestationDigest) ||
		!isDigest(value.audit.resultDigest) ||
		!isDigest(value.audit.previousLedgerDigest) ||
		!isDigest(value.audit.ledgerDigest) ||
		!hasExactKeys(value.audit.registration, [
			"status",
			"cluster",
			"routerUrl",
			"signature",
			"signer",
			"slot",
			"commitmentDigest",
			"memo",
			"verifiedAt",
		])
	) {
		return false;
	}
	const registration = value.audit.registration;
	return (
		registration.status === "confirmed" &&
		registration.cluster === "devnet" &&
		registration.routerUrl === "https://devnet-router.magicblock.app/" &&
		typeof registration.signature === "string" &&
		/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(registration.signature) &&
		isCanonicalSolanaPublicKey(registration.signer) &&
		Number.isSafeInteger(registration.slot) &&
		Number(registration.slot) >= 0 &&
		isDigest(registration.commitmentDigest) &&
		isBoundAuditMemo(
			registration.memo,
			value.audit.auditEventId as string,
			registration.commitmentDigest as string,
			value.audit.previousLedgerDigest as string,
			value.audit.ledgerDigest as string,
			value.outcome as "review_required" | "incompatible",
		) &&
		isCanonicalTimestamp(registration.verifiedAt)
	);
}

function isBoundAuditMemo(
	value: unknown,
	auditEventId: string,
	commitmentDigest: string,
	previousLedgerDigest: string,
	ledgerDigest: string,
	outcome: "review_required" | "incompatible",
): boolean {
	if (
		typeof value !== "string" ||
		!value.startsWith("compass:audit:v1:")
	) {
		return false;
	}
	try {
		const encoded = value.slice("compass:audit:v1:".length);
		const memo = JSON.parse(encoded) as Record<string, unknown>;
		return (
			canonicalJson(memo) === encoded &&
			hasExactKeys(memo, ["a", "c", "l", "o", "p", "v"]) &&
			memo.a === auditEventId &&
			memo.c === commitmentDigest &&
			memo.l === ledgerDigest &&
			memo.p === previousLedgerDigest &&
			memo.o ===
				(outcome === "review_required" ? "review" : "incompatible") &&
			memo.v === 1
		);
	} catch {
		return false;
	}
}
