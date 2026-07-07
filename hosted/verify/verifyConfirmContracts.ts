import type { Discrepancy } from "@shared/verdictContracts";

export type VerifyConfirmRequest = {
	correlationId: string;
	txSignature: string;
};

export type VerifyConfirmOutcome =
	| "match"
	| "mismatch"
	| "unconfirmed"
	| "unknown_correlation"
	| "pending"
	| "unverified_no_decoder"
	| "execution_failed"
	| "error";

export type VerifyConfirmResponse = {
	correlationId: string;
	outcome: VerifyConfirmOutcome;
	discrepancies: Discrepancy[];
};

export type VerifyConfirmRequestValidationResult =
	| { ok: true; request: VerifyConfirmRequest }
	| { ok: false; message: string };

export type VerifyConfirmService = {
	verifyConfirm(request: VerifyConfirmRequest): Promise<VerifyConfirmResponse>;
};
