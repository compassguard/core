import { describe, expect, it, vi } from "vitest";

import { createBoundedMagicBlockHttpsTransport } from "../magicBlockDevnetHttpsTransport";
import {
	MAGICBLOCK_OBSERVATION_SCHEMA,
	type MagicBlockFetch,
} from "../magicBlockDevnetObservationContracts";
import { createRequestScopedMagicBlockDependencies } from "../magicBlockDevnetRequestScope";
import { decodeTrustedUnsignedV0NoAltCandidate } from "../magicBlockDevnetTransactionDecoder";
import {
	MAGICBLOCK_MAX_RESPONSE_BYTES,
	MAGICBLOCK_ROUTER_URL,
	type MagicBlockPostRequest,
} from "../magicBlockDevnetPreflightTypes";

describe("MagicBlock runtime foundation", () => {
	it("decodes only an unsigned v0 transaction without address lookup tables", () => {
		const decoded = decodeTrustedUnsignedV0NoAltCandidate({
			schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
			observationId: "obs-1",
			unsignedTransactionBase64: unsignedV0Transaction(),
		});

		expect(decoded.candidate.accounts).toHaveLength(2);
		expect(decoded.candidate.accounts[0]).toMatchObject({
			isSigner: true,
			isWritable: true,
			isProgram: false,
			isPayer: true,
		});
		expect(decoded.candidate.accounts[1]).toMatchObject({
			isSigner: false,
			isWritable: false,
			isProgram: true,
			isPayer: false,
		});
		expect(decoded.candidate.decodedPlan.accountIndexes).toEqual(["0", "1"]);
		expect(Object.isFrozen(decoded.candidate.accounts)).toBe(true);
	});

	it.each([
		["a nonzero signature", { signatureByte: 1 }],
		["a legacy message", { versionPrefix: 0 }],
		["address lookup tables", { lookupCount: 1 }],
		["trailing transaction bytes", { trailingByte: 1 }],
	])("rejects %s", (_name, mutation) => {
		expect(() =>
			decodeTrustedUnsignedV0NoAltCandidate({
				schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
				observationId: "obs-1",
				unsignedTransactionBase64: unsignedV0Transaction(mutation),
			}),
		).toThrow("observation unavailable");
	});

	it("keeps the candidate source and plan store immutable and request-scoped", async () => {
		const candidate = decodeTrustedUnsignedV0NoAltCandidate({
			schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
			observationId: "obs-1",
			unsignedTransactionBase64: unsignedV0Transaction(),
		}).candidate;
		const scoped = createRequestScopedMagicBlockDependencies({
			opaqueCandidateRef: "candidate-ref",
			candidate,
		});

		await expect(
			scoped.candidateSource.source.resolveImmutable("another-request"),
		).resolves.toBeNull();
		const first = await scoped.candidateSource.source.resolveImmutable("candidate-ref");
		const second = await scoped.candidateSource.source.resolveImmutable("candidate-ref");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first?.accounts)).toBe(true);
	});

	it("posts only to the literal HTTPS Router and bounds the response while streaming", async () => {
		const calls: Parameters<MagicBlockFetch>[] = [];
		const fetchImpl: MagicBlockFetch = vi.fn(async (...args) => {
			calls.push(args);
			return streamResponse([
				new TextEncoder().encode('{"jsonrpc":"2.0"}'),
			]);
		});
		const post = createBoundedMagicBlockHttpsTransport({ fetchImpl });
		const response = await post(validPostRequest());

		expect(response).toMatchObject({
			status: 200,
			url: MAGICBLOCK_ROUTER_URL,
			redirected: false,
			body: '{"jsonrpc":"2.0"}',
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe(MAGICBLOCK_ROUTER_URL);
		expect(calls[0]?.[1]).toMatchObject({
			method: "POST",
			redirect: "error",
		});
	});

	it("cancels an oversized response before returning buffered content", async () => {
		let cancelled = false;
		const fetchImpl: MagicBlockFetch = async () => {
			const response = streamResponse([
				new Uint8Array(MAGICBLOCK_MAX_RESPONSE_BYTES),
				new Uint8Array([1]),
			]);
			const original = response.body?.getReader;
			return {
				...response,
				body: {
					getReader() {
						const reader = original?.call(response.body);
						if (!reader) throw new Error("missing reader");
						return {
							...reader,
							async cancel(reason?: unknown) {
								cancelled = true;
								await reader.cancel(reason);
							},
						};
					},
				},
			};
		};
		const post = createBoundedMagicBlockHttpsTransport({ fetchImpl });

		await expect(post(validPostRequest())).rejects.toThrow(
			"MagicBlock transport unavailable",
		);
		expect(cancelled).toBe(true);
	});

	it("rejects any runtime endpoint substitution before dispatch", async () => {
		const fetchImpl = vi.fn<
			Parameters<MagicBlockFetch>,
			ReturnType<MagicBlockFetch>
		>();
		const post = createBoundedMagicBlockHttpsTransport({ fetchImpl });
		const request = {
			...validPostRequest(),
			url: "https://example.test/",
		} as unknown as MagicBlockPostRequest;

		await expect(post(request)).rejects.toThrow("MagicBlock transport unavailable");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects an expired overall deadline before dispatch", async () => {
		const fetchImpl = vi.fn<
			Parameters<MagicBlockFetch>,
			ReturnType<MagicBlockFetch>
		>();
		const post = createBoundedMagicBlockHttpsTransport({
			fetchImpl,
			nowEpochMs: () => 1_000,
		});

		await expect(
			post({ ...validPostRequest(), deadlineAtEpochMs: 999 }),
		).rejects.toThrow("MagicBlock transport unavailable");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

function validPostRequest(): MagicBlockPostRequest {
	return {
		url: MAGICBLOCK_ROUTER_URL,
		method: "POST",
		redirect: "error",
		headers: { "content-type": "application/json" },
		body: "{}",
		maxResponseBytes: MAGICBLOCK_MAX_RESPONSE_BYTES,
		deadlineAtEpochMs: Date.now() + 1_000,
	};
}

function streamResponse(chunks: Uint8Array[]) {
	let index = 0;
	return {
		status: 200,
		url: MAGICBLOCK_ROUTER_URL,
		redirected: false,
		body: {
			getReader() {
				return {
					async read() {
						const value = chunks[index++];
						return value
							? ({ done: false, value } as const)
							: ({ done: true } as const);
					},
					async cancel() {
						index = chunks.length;
					},
					releaseLock() {},
				};
			},
		},
	};
}

export function unsignedV0Transaction(
	mutation: {
		readonly signatureByte?: number;
		readonly versionPrefix?: number;
		readonly lookupCount?: number;
		readonly trailingByte?: number;
	} = {},
): string {
	const bytes = [
		1,
		...Array.from({ length: 64 }, (_, index) =>
			index === 0 ? (mutation.signatureByte ?? 0) : 0,
		),
		mutation.versionPrefix ?? 0x80,
		1,
		0,
		1,
		2,
		...Array.from({ length: 32 }, (_, index) => index + 1),
		...Array.from({ length: 32 }, (_, index) => index + 33),
		...Array.from({ length: 32 }, () => 7),
		1,
		1,
		1,
		0,
		0,
		mutation.lookupCount ?? 0,
	];
	if (mutation.trailingByte !== undefined) bytes.push(mutation.trailingByte);
	return Buffer.from(bytes).toString("base64");
}
