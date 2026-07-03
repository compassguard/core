export type HostedErrorCode = "INTERNAL_ERROR";

export type HostedErrorResponse = {
	error: {
		code: HostedErrorCode;
		message: string;
	};
};
