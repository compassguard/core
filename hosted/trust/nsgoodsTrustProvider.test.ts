import { describe, expect, it } from "vitest";

import { TRUST_VERDICTS } from "@shared/trustContracts";

import { createNsgoodsTrustProvider } from "./nsgoodsTrustProvider";

const jsonResponse = (body: unknown, ok = true, status = 200) =>
	new Response(JSON.stringify(body), { status: ok ? status : 502 });

describe("createNsgoodsTrustProvider — fail-open (the vendor helper's bug)", () => {
	it("returns NO_SIGNAL instead of throwing when the network fails", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
		});

		await expect(provider.screen("7xKqabc")).resolves.toEqual({
			verdict: TRUST_VERDICTS.NO_SIGNAL,
			reasons: [],
		});
	});

	it("returns NO_SIGNAL when the upstream 502s with an HTML error page", async () => {
		// The exact case the reference helper blew up on: no res.ok check, and
		// JSON.parse of an HTML body threw straight into the caller.
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () =>
				Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })),
		});

		await expect(provider.screen("7xKqabc")).resolves.toEqual({
			verdict: TRUST_VERDICTS.NO_SIGNAL,
			reasons: [],
		});
	});

	it("returns NO_SIGNAL when a 200 body is not valid JSON", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => Promise.resolve(new Response("not json", { status: 200 })),
		});

		await expect(provider.screen("7xKqabc")).resolves.toEqual({
			verdict: TRUST_VERDICTS.NO_SIGNAL,
			reasons: [],
		});
	});

	it("returns NO_SIGNAL rather than hanging when the upstream never responds", async () => {
		const provider = createNsgoodsTrustProvider({
			timeoutMs: 20,
			fetchImpl: () => new Promise<Response>(() => {}), // never settles
		});

		const signal = await provider.screen("7xKqabc");

		expect(signal.verdict).toBe(TRUST_VERDICTS.NO_SIGNAL);
	});

	it("discards a response that fails signature verification", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => Promise.resolve(jsonResponse({ result: { malicious: true } })),
			verifySignature: () => Promise.resolve(false),
		});

		const signal = await provider.screen("7xKqabc");

		expect(signal.verdict).toBe(TRUST_VERDICTS.NO_SIGNAL);
	});
});

describe("createNsgoodsTrustProvider — verdict mapping", () => {
	const screenWith = (body: unknown) =>
		createNsgoodsTrustProvider({
			fetchImpl: () => Promise.resolve(jsonResponse(body)),
		}).screen("7xKqabc");

	it("maps a sanctions hit to SANCTIONED", async () => {
		const signal = await screenWith({ result: { sanctioned: true } });

		expect(signal.verdict).toBe(TRUST_VERDICTS.SANCTIONED);
		expect(signal.evidence).toBeDefined();
	});

	it("maps a malicious-address hit to MALICIOUS", async () => {
		const signal = await screenWith({ result: { malicious: true } });

		expect(signal.verdict).toBe(TRUST_VERDICTS.MALICIOUS);
	});

	it("prefers the sanctions hit when an address is both sanctioned and malicious", async () => {
		const signal = await screenWith({
			result: { sanctioned: true, malicious: true },
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.SANCTIONED);
	});

	it("maps a revocation to REVOKED", async () => {
		const signal = await screenWith({
			result: { inputs: { revoked_count: 1 } },
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.REVOKED);
	});

	it("maps thin evidence to INSUFFICIENT_EVIDENCE", async () => {
		const signal = await screenWith({
			result: {
				inputs: { distinct_clients: 2, min_distinct_clients_required: 3 },
			},
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.INSUFFICIENT_EVIDENCE);
	});

	it("maps a flag-free response to CLEAN — never to anything that could permit", async () => {
		const signal = await screenWith({
			result: {
				score: 95.72, // present in the payload, and deliberately never read
				inputs: {
					revoked_count: 0,
					distinct_clients: 120,
					min_distinct_clients_required: 3,
				},
			},
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.CLEAN);
		// CLEAN imposes nothing; it is not a vouch. There is no verdict that could
		// relax a decision, so a high score has nowhere to go.
	});

	it("returns NO_SIGNAL for an unrecognized body shape", async () => {
		const signal = await screenWith({ unexpected: "shape" });

		expect(signal.verdict).toBe(TRUST_VERDICTS.NO_SIGNAL);
	});

	it("returns NO_SIGNAL for a blank address without calling the network", async () => {
		let called = false;
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => {
				called = true;
				return Promise.resolve(jsonResponse({ result: {} }));
			},
		});

		const signal = await provider.screen("   ");

		expect(signal.verdict).toBe(TRUST_VERDICTS.NO_SIGNAL);
		expect(called).toBe(false);
	});
});
