import { createInMemoryWaitlistStore } from "./waitlistStore";
import { describeWaitlistStoreContract } from "./waitlistStoreContract";

// The in-memory reference implementation is held to the shared WaitlistStore contract — the
// same suite the durable Postgres backing runs (waitlistStorePg.test.ts), so the two stay
// behaviorally identical and the durable swap is drop-in.
describeWaitlistStoreContract("createInMemoryWaitlistStore", () => createInMemoryWaitlistStore());
