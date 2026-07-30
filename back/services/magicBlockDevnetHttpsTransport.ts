import {
	deepFreeze,
	hasExactKeys,
} from "./magicBlockDevnetPreflightCanonical";
import type {
	MagicBlockFetch,
	MagicBlockFetchResponse,
} from "./magicBlockDevnetObservationContracts";
import {
	MAGICBLOCK_MAX_RESPONSE_BYTES,
	MAGICBLOCK_PROVIDER_TIMEOUT_MS,
	MAGICBLOCK_ROUTER_URL,
	type MagicBlockPost,
} from "./magicBlockDevnetPreflightTypes";

export function createBoundedMagicBlockHttpsTransport(input: {
	readonly fetchImpl?: MagicBlockFetch;
	readonly timeoutMs?: number;
	readonly nowEpochMs?: () => number;
} = {}): MagicBlockPost {
	const fetchImpl =
		input.fetchImpl ??
		((url, init) =>
			globalThis.fetch(url, init) as unknown as Promise<MagicBlockFetchResponse>);
	const configuredTimeoutMs = input.timeoutMs ?? MAGICBLOCK_PROVIDER_TIMEOUT_MS;
	const nowEpochMs = input.nowEpochMs ?? Date.now;
	if (
		!Number.isSafeInteger(configuredTimeoutMs) ||
		configuredTimeoutMs <= 0 ||
		configuredTimeoutMs > MAGICBLOCK_PROVIDER_TIMEOUT_MS
	) {
		throw new Error("MagicBlock transport unavailable");
	}

	return async (request) => {
		validateLiteralRequest(request);
		const remainingMs = request.deadlineAtEpochMs - nowEpochMs();
		const timeoutMs = Math.min(configuredTimeoutMs, remainingMs);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			throw new Error("MagicBlock transport unavailable");
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(MAGICBLOCK_ROUTER_URL, {
				method: "POST",
				redirect: "error",
				headers: { "content-type": "application/json" },
				body: request.body,
				signal: controller.signal,
			});
			if (
				response.url !== MAGICBLOCK_ROUTER_URL ||
				response.redirected ||
				response.body === null
			) {
				throw new Error("MagicBlock transport unavailable");
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let byteLength = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					if (!(chunk.value instanceof Uint8Array)) {
						throw new Error("MagicBlock transport unavailable");
					}
					byteLength += chunk.value.byteLength;
					if (byteLength > MAGICBLOCK_MAX_RESPONSE_BYTES) {
						await reader.cancel("response exceeds streaming limit").catch(() => undefined);
						throw new Error("MagicBlock transport unavailable");
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = new Uint8Array(byteLength);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return deepFreeze({
				status: response.status,
				url: response.url,
				redirected: response.redirected,
				body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			});
		} finally {
			clearTimeout(timeout);
		}
	};
}

function validateLiteralRequest(request: Parameters<MagicBlockPost>[0]): void {
	const parsed = new URL(request.url);
	if (
		!hasExactKeys(request, [
			"url",
			"method",
			"redirect",
			"headers",
			"body",
			"maxResponseBytes",
			"deadlineAtEpochMs",
		]) ||
		request.url !== MAGICBLOCK_ROUTER_URL ||
		request.method !== "POST" ||
		request.redirect !== "error" ||
		!hasExactKeys(request.headers, ["content-type"]) ||
		request.headers["content-type"] !== "application/json" ||
		typeof request.body !== "string" ||
		request.maxResponseBytes !== MAGICBLOCK_MAX_RESPONSE_BYTES ||
		!Number.isSafeInteger(request.deadlineAtEpochMs) ||
		parsed.protocol !== "https:" ||
		parsed.hostname !== "devnet-router.magicblock.app" ||
		parsed.port !== "" ||
		parsed.pathname !== "/" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error("MagicBlock transport unavailable");
	}
}
