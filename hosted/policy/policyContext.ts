import type { PolicyEvaluationContext } from "@shared/policyContracts";

/**
 * Build a PolicyEvaluationContext from a tool call's arguments.
 *
 * NOTE (MVP honesty gap): flags here are read from the agent's SELF-REPORTED
 * args. Decoded ground-truth derivation is the decode workstream (see
 * docs/compass-demo-day/decode-handoff.md); when that lands, the same
 * PolicyEvaluationContext shape is produced from the decoded tx instead.
 */
export function derivePolicyContext(
	actionKind: "transfer" | "swap",
	argumentsValue: Record<string, unknown> | undefined,
): PolicyEvaluationContext {
	const args = argumentsValue ?? {};

	if (actionKind === "transfer") {
		return {
			amount_usd: readNumber(args, ["amountUsd", "amount_usd", "usdAmount"]),
			recipient_address: readString(args, [
				"recipient",
				"recipientAddress",
				"destination",
				"address",
			]),
			recipient_known: readBoolean(args, ["recipientKnown", "recipient_known"]),
			flags: {
				suspicious_recipient: readBoolean(args, [
					"suspiciousRecipient",
					"suspicious_recipient",
				]),
				unknown_program: readBoolean(args, ["unknownProgram", "unknown_program"]),
				unlimited_delegate: readBoolean(args, [
					"unlimitedDelegate",
					"unlimited_delegate",
				]),
				authority_change: readBoolean(args, [
					"authorityChange",
					"authority_change",
				]),
			},
		};
	}

	return {
		amount_usd: readNumber(args, ["amountUsd", "amount_usd", "usdAmount"]),
		token_mint: readString(args, [
			"tokenMint",
			"outputTokenMint",
			"toTokenMint",
		]),
		token_known: readBoolean(args, ["tokenKnown", "token_known"]),
		protocol: readString(args, ["protocol"]),
		slippage_bps: readNumber(args, ["slippageBps", "slippage_bps"]),
	};
}

function readString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function readNumber(
	record: Record<string, unknown>,
	keys: string[],
): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}

	return undefined;
}

function readBoolean(
	record: Record<string, unknown>,
	keys: string[],
): boolean | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") {
			return value;
		}
	}

	return undefined;
}
