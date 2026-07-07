import { createInMemoryVerdictStore } from "./verdictStore";
import { describeVerdictStoreContract } from "./verdictStoreContract";

// The in-memory reference implementation is held to the shared VerdictStore contract —
// the same suite the durable Postgres backing runs (verdictStorePg.test.ts), so the two
// stay behaviorally identical and the durable swap is drop-in.
describeVerdictStoreContract("createInMemoryVerdictStore", (options) =>
	createInMemoryVerdictStore(options),
);
