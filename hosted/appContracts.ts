import type { HealthRouteDependencies } from "./health/healthContracts";
import type { HostedAuthConfig } from "@shared/hostedAuthMiddlewareContracts";
import type { AuditStore } from "./audit/auditContracts";
import type { EvaluationService } from "./evaluate/evaluationContracts";
import type { PolicyService } from "./policies/policyContracts";
import type { VerifyService } from "./verify/verifyContracts";
import type { VerifyConfirmService } from "./verify/verifyConfirmContracts";
import type { VerdictStore } from "./verdict/verdictStore";
import type { CredentialStore } from "./credential/credentialStore";

export type HostedAppDependencies = {
	auth: HostedAuthConfig;
	health: HealthRouteDependencies;
	evaluations?: EvaluationService;
	audit?: AuditStore;
	policies?: PolicyService;
	verifications?: VerifyService;
	confirmations?: VerifyConfirmService;
	verdictStore?: VerdictStore;
	credentialStore?: CredentialStore;
};
