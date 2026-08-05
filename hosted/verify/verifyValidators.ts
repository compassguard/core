import { STATED_PURPOSE_MAX_LENGTH } from "@shared/mandateContracts";

import type { VerifyActionRequestValidationResult } from "./verifyContracts";

/**
 * Every argument alias derivePolicyContext reads a USD amount from (hosted/policy/
 * policyContext.ts — readNumber(["amountUsd", "amount_usd", "usdAmount"]) on both the
 * transfer and swap branches). Kept in sync with that list: an alias missing here is an
 * unvalidated path to the same intendedEffect.amountUsd field.
 */
const USD_AMOUNT_KEYS = ["amountUsd", "amount_usd", "usdAmount"] as const;

export function validateVerifyActionRequest(
	value: unknown,
): VerifyActionRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}

	if (!isNonEmptyString(value.toolName)) {
		return { ok: false, message: "toolName is required." };
	}

	if (value.arguments !== undefined && !isRecord(value.arguments)) {
		return { ok: false, message: "arguments must be an object when provided." };
	}

	// A USD amount must be a non-negative finite number. Rejected HERE, at the boundary,
	// rather than clamped downstream: a negative amount is persisted on the verdict's
	// intendedEffect and then SUMMED by the metrics dashboard, so one caller sending -1000000 drags
	// the reported funds-secured / possible-funds-lost totals negative for everyone. The
	// aliases mirror derivePolicyContext's readNumber keys — a rejection that missed an
	// alias would be no rejection at all.
	if (isRecord(value.arguments)) {
		for (const key of USD_AMOUNT_KEYS) {
			const amount = value.arguments[key];
			if (amount === undefined) continue;
			if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
				return {
					ok: false,
					message: `arguments.${key} must be a non-negative finite number.`,
				};
			}
		}
	}

	if (value.intent !== undefined) {
		if (!isRecord(value.intent)) {
			return { ok: false, message: "intent must be an object when provided." };
		}
		if (value.intent.kind !== "transfer" && value.intent.kind !== "swap") {
			return {
				ok: false,
				message: 'intent.kind must be "transfer" or "swap".',
			};
		}
		if (value.intent.statedPurpose !== undefined) {
			if (!isNonEmptyString(value.intent.statedPurpose)) {
				return {
					ok: false,
					message: "intent.statedPurpose must be a non-empty string when provided.",
				};
			}
			if (value.intent.statedPurpose.length > STATED_PURPOSE_MAX_LENGTH) {
				return {
					ok: false,
					message: `intent.statedPurpose must be at most ${STATED_PURPOSE_MAX_LENGTH} characters.`,
				};
			}
		}
	}

	// A provided requestedAt must be a parseable ISO-8601 timestamp so decidedAt /
	// createdAt cannot be backdated or poisoned with a NaN date (D11 / #12). When
	// omitted it stays undefined and verifyService server-stamps it via isoNow.
	if (value.requestedAt !== undefined) {
		if (
			!isNonEmptyString(value.requestedAt) ||
			Number.isNaN(Date.parse(value.requestedAt))
		) {
			return {
				ok: false,
				message: "requestedAt must be an ISO-8601 timestamp.",
			};
		}
	}

	// Attribution, when provided, must be a non-empty string. A present-but-malformed value
	// (e.g. a number from a JS caller) would otherwise be silently coerced to undefined below,
	// dropping who/which-session at the boundary — the exact silent-drop defect the durable
	// attribution work exists to fix. Reject it, mirroring the requestedAt handling above.
	if (value.userId !== undefined && !isNonEmptyString(value.userId)) {
		return {
			ok: false,
			message: "userId must be a non-empty string when provided.",
		};
	}
	if (value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) {
		return {
			ok: false,
			message: "sessionId must be a non-empty string when provided.",
		};
	}

	return {
		ok: true,
		request: {
			toolName: value.toolName,
			arguments: value.arguments as Record<string, unknown> | undefined,
			intent: isRecord(value.intent)
				? {
						kind: value.intent.kind as "transfer" | "swap",
						...(isNonEmptyString(value.intent.statedPurpose)
							? { statedPurpose: value.intent.statedPurpose }
							: {}),
					}
				: undefined,
			requestedAt: isNonEmptyString(value.requestedAt)
				? value.requestedAt
				: undefined,
			userId: isNonEmptyString(value.userId) ? value.userId : undefined,
			sessionId: isNonEmptyString(value.sessionId) ? value.sessionId : undefined,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
