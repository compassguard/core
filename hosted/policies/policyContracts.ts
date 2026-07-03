import type { PolicySnapshot } from "../evaluate/evaluationContracts";

export type PolicySnapshotResponse = PolicySnapshot;

export type PolicyService = {
	getPolicySnapshot: () => PolicySnapshotResponse;
	getHealthStatus: () => "ok" | "degraded" | "down";
};
