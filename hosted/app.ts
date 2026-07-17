import { Hono } from "hono";
import { createInMemoryAuditStore } from "./audit/auditStore";
import { createAuditRoutes } from "./audit/auditRoutes";
import { createEvaluationService } from "./evaluate/evaluationService";
import { createEvaluationRoutes } from "./evaluate/evaluationRoutes";
import { createHealthRoutes } from "./health/healthRoutes";
import { hostedAuthMiddleware } from "./http/hostedAuthMiddleware";
import { hostedErrorHandler } from "./http/hostedErrorMiddleware";
import { createPolicyService } from "./policies/policyService";
import { createPolicyRoutes } from "./policies/policyRoutes";
import { createVerdictStoreFromEnv } from "./verdict/verdictStoreFromEnv";
import type { VerdictStore } from "./verdict/verdictStoreTypes";
import { createCredentialStoreFromEnv } from "./credential/credentialStoreFromEnv";
import { createSignupService } from "./signup/signupService";
import { createSignupRoutes } from "./signup/signupRoutes";
import { createVerifyService } from "./verify/verifyService";
import { createNsgoodsTrustProvider } from "./trust/nsgoodsTrustProvider";
import { DEFAULT_TRUST_POLICY } from "./trust/trustSignal";
import { createVerifyConfirmService } from "./verify/verifyConfirmService";
import { createBoundedConfirmedTxFetcher } from "./verify/getConfirmedTx";
import { deriveActualEffectUnavailable } from "./verify/deriveActualEffect.unavailable";
import { createVerifyRoutes } from "./verify/verifyRoutes";
import type { HostedAppDependencies } from "./appContracts";

export function createHostedApp(deps: HostedAppDependencies): Hono {
	const app = new Hono();
	const auditStore = deps.audit ?? createInMemoryAuditStore();
	const policyService = deps.policies ?? createPolicyService();
	const evaluationService =
		deps.evaluations ??
		createEvaluationService({
			writeAudit: auditStore.writeAudit,
		});
	// #15: verifyService and verifyConfirmService MUST share one verdict store, or /verify and
	// /verify/confirm see different state. Injecting exactly one service would leave the other on
	// the fallback store — a split-brain lease. Fail loudly on that inconsistent partial injection.
	if ((deps.verifications === undefined) !== (deps.confirmations === undefined)) {
		throw new Error(
			"createHostedApp: inject BOTH verifications and confirmations, or neither — they must share a single verdict store.",
		);
	}
	// Build the fallback verdict store lazily and at most once — only if a verify service is not
	// injected, and only after the guard above so a rejected partial injection has no side effects
	// (no stray pooler client, no logging). Both fallback services share the SAME instance (#15).
	let sharedVerdictStore: VerdictStore | undefined = deps.verdictStore;
	const resolveVerdictStore = (): VerdictStore =>
		(sharedVerdictStore ??= createVerdictStoreFromEnv());
	const verifyService =
		deps.verifications ??
		createVerifyService({
			verdictStore: resolveVerdictStore(),
			// Counterparty screening — only active when a provider was wired in
			// (createDefaultHostedAppDependencies does so under an env flag); absent
			// → behaviour unchanged, no network call on the verify path.
			trustProvider: deps.trustProvider,
			trustPolicy: deps.trustPolicy,
		});
	const verifyConfirmService =
		deps.confirmations ??
		createVerifyConfirmService({
			verdictStore: resolveVerdictStore(),
			getConfirmedTx: createBoundedConfirmedTxFetcher(),
			deriveActualEffect: deriveActualEffectUnavailable,
		});

	// Per-email credential store (D13): env-selected durable Supabase or in-memory fallback,
	// built once and shared by the /v1 auth middleware and the public signup endpoint.
	const credentialStore = deps.credentialStore ?? createCredentialStoreFromEnv();

	app.onError(hostedErrorHandler);
	app.route("/health", createHealthRoutes(deps.health));
	// POST /signup is public (outside /v1, like /health): a caller mints an email credential
	// here, then presents it as a Bearer token to /v1/*.
	app.route("/", createSignupRoutes(createSignupService({ credentialStore })));
	app.use("/v1/*", hostedAuthMiddleware(deps.auth, credentialStore));
	app.route("/v1", createEvaluationRoutes(evaluationService));
	app.route("/v1", createVerifyRoutes(verifyService, verifyConfirmService));
	app.route("/v1", createAuditRoutes(auditStore));
	app.route("/v1", createPolicyRoutes(policyService));

	return app;
}

export function createDefaultHostedAppDependencies(
	env: Record<string, string | undefined> = process.env,
): HostedAppDependencies {
	// Counterparty screening is opt-in per deployment: enabling it adds a bounded,
	// fail-open network call to the /verify path, so it stays off unless the env
	// flag is set (keeping tests and unconfigured runs network-free). The signal is
	// negative-evidence-only, so turning it on can never relax a verdict.
	const screeningEnabled = env.COMPASS_TRUST_SCREENING_ENABLED === "1";

	return {
		auth: {
			apiKey: env.COMPASS_HOSTED_API_KEY,
		},
		health: {
			dependencies: {
				auditStore: "ok",
				policy: "ok",
				llm: "ok",
			},
		},
		...(screeningEnabled
			? {
					trustProvider: createNsgoodsTrustProvider({
						chain: "solana",
						baseUrl: env.COMPASS_TRUST_BASE_URL,
					}),
					trustPolicy: DEFAULT_TRUST_POLICY,
				}
			: {}),
	};
}
