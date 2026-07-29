import {
	MAGICBLOCK_MAX_TRANSACTION_BYTES,
	MAGICBLOCK_OBSERVATION_SCHEMA,
} from "../../magicBlockDevnetObservationContracts";
import { hasExactKeys, isOpaqueIdentifier } from "../../magicBlockDevnetPreflightCanonical";
import type { MagicBlockMcpObservation } from "./magicBlockMcpObserverContracts";

const MAX_CANONICAL_TRANSACTION_BASE64_LENGTH = 1_648;
const CANONICAL_BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Examines only the structured-content root. Text content and nested values
 * are deliberately outside this extractor's input contract.
 */
export function extractMagicBlockObservationFromStructuredContent(
	structuredContent: unknown,
): MagicBlockMcpObservation | undefined {
	if (
		!hasExactKeys(structuredContent, [
			"schemaVersion",
			"observationId",
			"unsignedTransactionBase64",
		]) ||
		structuredContent.schemaVersion !== MAGICBLOCK_OBSERVATION_SCHEMA ||
		!isOpaqueIdentifier(structuredContent.observationId) ||
		!isBoundedCanonicalBase64(structuredContent.unsignedTransactionBase64)
	) {
		return undefined;
	}

	return Object.freeze({
		schemaVersion: MAGICBLOCK_OBSERVATION_SCHEMA,
		observationId: structuredContent.observationId,
		unsignedTransactionBase64: structuredContent.unsignedTransactionBase64,
	});
}

function isBoundedCanonicalBase64(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_CANONICAL_TRANSACTION_BASE64_LENGTH ||
		value.length % 4 !== 0 ||
		!CANONICAL_BASE64.test(value)
	) {
		return false;
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const lastDataCharacter = value[value.length - padding - 1];
	const lastDataIndex =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
			lastDataCharacter ?? "",
		);
	if (
		(padding === 2 && lastDataIndex % 16 !== 0) ||
		(padding === 1 && lastDataIndex % 4 !== 0)
	) {
		return false;
	}
	const decodedBytes = (value.length / 4) * 3 - padding;
	return decodedBytes > 0 && decodedBytes <= MAGICBLOCK_MAX_TRANSACTION_BYTES;
}
