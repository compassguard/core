import { describeMandateStoreContract } from "./mandateStoreContract";
import { createInMemoryMandateStore } from "./mandateStore";

describeMandateStoreContract("createInMemoryMandateStore", () =>
	createInMemoryMandateStore(),
);
