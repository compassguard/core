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
import type { VerdictStore } from "./verdict/verdictStore";
import { createVerifyService } from "./verify/verifyService";
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
		createVerifyService({ verdictStore: resolveVerdictStore() });
	const verifyConfirmService =
		deps.confirmations ??
		createVerifyConfirmService({
			verdictStore: resolveVerdictStore(),
			getConfirmedTx: createBoundedConfirmedTxFetcher(),
			deriveActualEffect: deriveActualEffectUnavailable,
		});

	app.onError(hostedErrorHandler);
	app.route("/health", createHealthRoutes(deps.health));
	app.use("/v1/*", hostedAuthMiddleware(deps.auth));
	app.route("/v1", createEvaluationRoutes(evaluationService));
	app.route("/v1", createVerifyRoutes(verifyService, verifyConfirmService));
	app.route("/v1", createAuditRoutes(auditStore));
	app.route("/v1", createPolicyRoutes(policyService));

	return app;
}

export function createDefaultHostedAppDependencies(
	env: Record<string, string | undefined> = process.env,
): HostedAppDependencies {
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
	};
}
