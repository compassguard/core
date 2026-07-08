import { createInMemoryCredentialStore } from "./credentialStore";
import { describeCredentialStoreContract } from "./credentialStoreContract";

// The in-memory reference implementation is held to the shared CredentialStore contract —
// the same suite the durable Postgres backing runs (credentialStorePg.test.ts), so the two
// stay behaviorally identical and the durable swap is drop-in.
describeCredentialStoreContract("createInMemoryCredentialStore", (options) =>
	createInMemoryCredentialStore(options),
);
