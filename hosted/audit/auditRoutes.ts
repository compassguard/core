import { Hono } from "hono";
import type { AuditStore } from "./auditContracts";
import {
	validateAuditQueryParams,
	validateAuditWriteRequest,
} from "./auditContracts";

export function createAuditRoutes(store: AuditStore): Hono {
	const routes = new Hono();

	routes.post("/audit/events", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateAuditWriteRequest(body);

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

		return context.json(await store.writeAudit(validation.request), 200);
	});

	routes.get("/audits", async (context) => {
		const validation = validateAuditQueryParams({
			userId: context.req.query("userId"),
			sessionId: context.req.query("sessionId"),
			limit: context.req.query("limit"),
		});

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

		return context.json({ audits: await store.listAudits(validation.query) }, 200);
	});

	return routes;
}
