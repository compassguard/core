import type { HealthRouteDependencies } from "./health/healthContracts";
import type { HostedAuthConfig } from "@shared/hostedAuthMiddlewareContracts";
import type { AuditStore } from "./audit/auditContracts";
import type { EvaluationService } from "./evaluate/evaluationContracts";
import type { PolicyService } from "./policies/policyContracts";
import type { VerifyService } from "./verify/verifyContracts";
import type { VerifyConfirmService } from "./verify/verifyConfirmContracts";
import type { VerdictStore } from "./verdict/verdictStoreTypes";
import type { CredentialStore } from "./credential/credentialStore";
import type { TrustPolicy, TrustProvider } from "@shared/trustContracts";

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
	/**
	 * Counterparty screening for the fallback verify service. Omitted → screening
	 * off, behaviour unchanged. Wired by createDefaultHostedAppDependencies when
	 * COMPASS_TRUST_SCREENING_ENABLED is set, so tests stay network-free by default.
	 */
	trustProvider?: TrustProvider;
	trustPolicy?: TrustPolicy;
};
