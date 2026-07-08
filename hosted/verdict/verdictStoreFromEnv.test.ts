import { describe, expect, it } from "vitest";

import { createVerdictStoreFromEnv } from "./verdictStoreFromEnv";

// Only the no-env fallback is exercised in CI (R7): the durable branch needs a live pooler
// and is discharged by a deploy-time smoke test, not the no-network suite.
describe("createVerdictStoreFromEnv", () => {
	it("falls back to a functional in-memory store when COMPASS_VERDICT_DB_URL is unset", async () => {
		const store = createVerdictStoreFromEnv(() => undefined);

		await store.putDecided({
			correlationId: "c1",
			decision: "review",
			reasons: [],
			humanExplanation: "e",
			intendedEffect: { actionKind: "transfer" },
			decidedAt: "2026-07-07T00:00:00.000Z",
		});
		expect((await store.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("treats a blank/whitespace URL as unset (falls back to in-memory)", async () => {
		const store = createVerdictStoreFromEnv(() => "   ");
		expect(await store.getByCorrelationId("nope")).toBeUndefined();
	});
});
