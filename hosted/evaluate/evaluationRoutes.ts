import { Hono } from "hono";
import type { EvaluationService } from "./evaluationContracts";
import { validateEvaluateActionRequest } from "./evaluationContracts";

export function createEvaluationRoutes(service: EvaluationService): Hono {
	const routes = new Hono();

	routes.post("/evaluate", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateEvaluateActionRequest(body);

		if (validation.ok === false) {
			return context.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: validation.message,
					},
				},
				400,
			);
		}

		const response = await service.evaluateAction(validation.request);
		return context.json(response, 200);
	});

	return routes;
}
