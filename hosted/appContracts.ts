import type { HealthRouteDependencies } from "./health/healthContracts";
import type { HostedAuthConfig } from "@shared/hostedAuthMiddlewareContracts";
import type { AuditStore } from "./audit/auditContracts";
import type { EvaluationService } from "./evaluate/evaluationContracts";
import type { PolicyService } from "./policies/policyContracts";
import type { VerifyService } from "./verify/verifyContracts";
import type { VerdictStore } from "./verdict/verdictStore";

export type HostedAppDependencies = {
	auth: HostedAuthConfig;
	health: HealthRouteDependencies;
	evaluations?: EvaluationService;
	audit?: AuditStore;
	policies?: PolicyService;
	verifications?: VerifyService;
	verdictStore?: VerdictStore;
};
