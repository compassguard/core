import { describe, expect, it } from "vitest";

import { TRUST_VERDICTS } from "@shared/trustContracts";

import { createNsgoodsTrustProvider } from "./nsgoodsTrustProvider";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("createNsgoodsTrustProvider — never throws, never relaxes (the vendor helper's bug)", () => {
	// The failure modes the reference helper let escape. Each must yield UNAVAILABLE
	// (a screen we could not complete → REVIEW), never an exception and never a
	// clean pass.
	it("returns UNAVAILABLE instead of throwing when the network fails", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
		});

		const signal = await provider.screen("7xKqabc");
		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
	});

	it("returns UNAVAILABLE when the upstream 502s with an HTML error page", async () => {
		// The exact case the reference helper blew up on: no res.ok check, and
		// JSON.parse of an HTML body threw straight into the caller.
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () =>
				Promise.resolve(
					new Response("<html>502 Bad Gateway</html>", { status: 502 }),
				),
		});

		const signal = await provider.screen("7xKqabc");
		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
	});

	it("returns UNAVAILABLE when a 200 body is not valid JSON", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () => Promise.resolve(new Response("not json", { status: 200 })),
		});

		const signal = await provider.screen("7xKqabc");
		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
	});

	it("returns UNAVAILABLE rather than hanging when the upstream never responds", async () => {
		const provider = createNsgoodsTrustProvider({
			timeoutMs: 20,
			fetchImpl: () => new Promise<Response>(() => {}), // never settles
		});

		const signal = await provider.screen("7xKqabc");
		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
	});

	it("returns UNAVAILABLE for a response that fails signature verification", async () => {
		const provider = createNsgoodsTrustProvider({
			fetchImpl: () =>
				Promise.resolve(jsonResponse({ result: { malicious: true } })),
			verifySignature: () => Promise.resolve(false),
		});

		const signal = await provider.screen("7xKqabc");
		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
	});
});

describe("createNsgoodsTrustProvider — request shape", () => {
	it("passes the recipient's chain (solana by default) so a Solana address is not screened as ethereum", async () => {
		let seenUrl = "";
		const provider = createNsgoodsTrustProvider({
			fetchImpl: (input) => {
				seenUrl = String(input);
				return Promise.resolve(jsonResponse({ result: {} }));
			},
		});

		await provider.screen("7xKqSolAddr");

		expect(seenUrl).toContain("address=7xKqSolAddr");
		expect(seenUrl).toContain("chain=solana");
	});
});

describe("createNsgoodsTrustProvider — verdict mapping (live /screen shape)", () => {
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

	it("maps a hard_flags hit to MALICIOUS even when the boolean is absent", async () => {
		const signal = await screenWith({
			result: { hard_flags: ["ofac_sanctioned"] },
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.MALICIOUS);
	});

	it("prefers the sanctions hit when an address is both sanctioned and malicious", async () => {
		const signal = await screenWith({
			result: { sanctioned: true, malicious: true },
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.SANCTIONED);
	});

	it("maps a soft_flags hit to SUSPICIOUS", async () => {
		const signal = await screenWith({
			result: { soft_flags: ["mixer_interaction"] },
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.SUSPICIOUS);
	});

	it("maps a 'review' screening_verdict to SUSPICIOUS", async () => {
		const signal = await screenWith({
			result: {},
			screening_verdict: "review",
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.SUSPICIOUS);
	});

	it("maps a flag-free response to CLEAN — never to anything that could permit", async () => {
		const signal = await screenWith({
			result: {
				sanctioned: false,
				malicious: false,
				hard_flags: [],
				soft_flags: [],
			},
			screening_verdict: "clean",
		});

		expect(signal.verdict).toBe(TRUST_VERDICTS.CLEAN);
		// CLEAN imposes nothing; it is not a vouch. There is no verdict that could
		// relax a decision, so a high score has nowhere to go.
	});

	it("maps a 2xx whose body has no result to UNAVAILABLE (could not screen ≠ clean)", async () => {
		const signal = await screenWith({ unexpected: "shape" });

		expect(signal.verdict).toBe(TRUST_VERDICTS.UNAVAILABLE);
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
