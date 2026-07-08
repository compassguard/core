export type SignupRequest = { email: string };

export type SignupResponse = { email: string; apiKey: string };

export type SignupRequestValidationResult =
	| { ok: true; request: SignupRequest }
	| { ok: false; message: string };

export type SignupService = {
	signup(request: SignupRequest): Promise<SignupResponse>;
};
