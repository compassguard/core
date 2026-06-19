import type { ErrorHandler } from "hono";
import type { HostedErrorResponse } from "@shared/hostedErrorMiddlewareContracts";

export const hostedErrorHandler: ErrorHandler = (error, context) => {
	console.error("Unhandled hosted guard error", {
		name: error.name,
		message: error.message,
	});

	return context.json<HostedErrorResponse>(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: "Hosted guard request failed.",
			},
		},
		500,
	);
};
