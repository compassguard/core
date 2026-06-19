export type HealthDependencyStatus = "ok" | "degraded" | "down";

export type HealthDependencies = {
	auditStore: HealthDependencyStatus;
	policy: HealthDependencyStatus;
	llm: HealthDependencyStatus;
};

export type HealthRouteDependencies = {
	dependencies: HealthDependencies;
};

export type HealthResponse = {
	ok: boolean;
	service: "compass-hosted-guard";
	dependencies: HealthDependencies;
};
