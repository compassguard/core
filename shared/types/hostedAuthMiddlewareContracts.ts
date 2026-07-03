export type HostedAuthConfig = {
	apiKey?: string;
};

export type HostedAuthErrorCode = "UNAUTHENTICATED";

export type HostedAuthErrorResponse = {
	error: {
		code: HostedAuthErrorCode;
		message: string;
	};
};
