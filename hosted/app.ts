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

	app.onError(hostedErrorHandler);
	app.route("/health", createHealthRoutes(deps.health));
	app.use("/v1/*", hostedAuthMiddleware(deps.auth));
	app.route("/v1", createEvaluationRoutes(evaluationService));
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
