export type WaitlistRequest = { email: string };

export type WaitlistResponse = { email: string };

export type WaitlistRequestValidationResult =
	| { ok: true; request: WaitlistRequest }
	| { ok: false; message: string };

export type WaitlistService = {
	join(request: WaitlistRequest): Promise<WaitlistResponse>;
};
