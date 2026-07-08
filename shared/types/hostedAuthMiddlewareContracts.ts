export type HostedAuthConfig = {
	apiKey?: string;
};

/**
 * Hono context variables the hosted auth middleware may set for downstream handlers.
 * `authenticatedEmail` is the credential-derived caller identity (undefined on the
 * shared-key fast path, which sets no identity).
 */
export type HostedContextVariables = { authenticatedEmail?: string };

export type HostedAuthErrorCode = "UNAUTHENTICATED";

export type HostedAuthErrorResponse = {
	error: {
		code: HostedAuthErrorCode;
		message: string;
	};
};
