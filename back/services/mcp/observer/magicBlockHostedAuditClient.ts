import {
	MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES,
	MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS,
	type MagicBlockMcpAuditClient,
	type MagicBlockMcpAuditTransport,
} from "./magicBlockMcpObserverContracts";
import {
	isSafeAuditApiKey,
	isSafeAuditUrl,
} from "./magicBlockMcpObserverConfig";

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
			globalThis.fetch(url, init) as Promise<{ readonly status: number }>);

	return {
		async observe(observation) {
			const body = JSON.stringify(observation);
			if (
				new TextEncoder().encode(body).byteLength >
				MAGICBLOCK_MCP_AUDIT_MAX_REQUEST_BYTES
			) {
				return { outcome: "transport_error" };
			}

			const controller = new AbortController();
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => {
					controller.abort();
					resolve("timeout");
				}, input.timeoutMs);
			});
			const request = Promise.resolve().then(() =>
				transport(input.url, {
					method: "POST",
					redirect: "error",
					headers: {
						Authorization: `Bearer ${input.apiKey}`,
						"Content-Type": "application/json",
					},
					body,
					signal: controller.signal,
				}),
			);

			try {
				const settled = await Promise.race([
					request.then(
						(response) => ({ kind: "response" as const, response }),
						() => ({ kind: "error" as const }),
					),
					timeout,
				]);
				if (settled === "timeout") return { outcome: "timeout" };
				if (settled.kind === "error") return { outcome: "transport_error" };
				if (
					!Number.isInteger(settled.response.status) ||
					settled.response.status < 100 ||
					settled.response.status > 599
				) {
					return { outcome: "transport_error" };
				}
				return settled.response.status >= 200 && settled.response.status < 300
					? { outcome: "delivered", status: settled.response.status }
					: { outcome: "rejected", status: settled.response.status };
			} finally {
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			}
		},
	};
}
