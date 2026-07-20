/**
 * Mandate contracts — the owner's registered policy (trusted anchor) the /verify LLM judge
 * compares stated intent against. Registered up front via POST /v1/mandate and looked up by
 * identity at verify time; never sent per verify call.
 */

export const MANDATE_TEXT_MAX_LENGTH = 2000;
export const STATED_PURPOSE_MAX_LENGTH = 500;
export const MANDATE_MAX_ALLOWED_RECIPIENTS = 50;

/** Which check actually ran for a /verify decision (seam-doc degraded modes). */
export const INTENT_SOURCES = {
	FULL: "full",
	SELF_REPORT: "self_report",
	NONE: "none",
} as const;

export type IntentSource = (typeof INTENT_SOURCES)[keyof typeof INTENT_SOURCES];

export type Mandate = {
	/** authenticatedEmail (credential-derived, preferred) or self-reported userId. */
	ownerId: string;
	/** Natural-language owner intent; 1..MANDATE_TEXT_MAX_LENGTH chars. */
	mandateText: string;
	/** Judge context only — NOT deterministic enforcement (Tier-3 per-user policies). */
	allowedRecipients?: string[];
	/** Judge context only — NOT deterministic enforcement. */
	maxAmountUsd?: number;
	updatedAt: string;
};

export type MandateStore = {
	/** Upsert by ownerId — the owner's latest mandate wins. */
	put(mandate: Mandate): Promise<void>;
	get(ownerId: string): Promise<Mandate | undefined>;
};
