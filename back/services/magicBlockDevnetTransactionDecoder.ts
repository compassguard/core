import { Buffer } from "node:buffer";

import { deepFreeze } from "./magicBlockDevnetPreflightCanonical";
import type {
	DecodedUnsignedMagicBlockCandidate,
	MagicBlockDevnetObservationV1,
} from "./magicBlockDevnetObservationContracts";
import { MAGICBLOCK_MAX_TRANSACTION_BYTES } from "./magicBlockDevnetObservationContracts";
import type {
	MagicBlockCandidateAccount,
} from "./magicBlockDevnetPreflightTypes";
import { MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS } from "./magicBlockDevnetPreflightTypes";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeTrustedUnsignedV0NoAltCandidate(
	observation: MagicBlockDevnetObservationV1,
): DecodedUnsignedMagicBlockCandidate {
	const serialized = decodeCanonicalBase64(observation.unsignedTransactionBase64);
	if (serialized.length === 0 || serialized.length > MAGICBLOCK_MAX_TRANSACTION_BYTES) {
		throw new Error("observation unavailable");
	}

	const cursor = createCursor(serialized);
	const signatureCount = cursor.shortVec();
	if (signatureCount === 0 || signatureCount > 64) throw new Error("observation unavailable");
	const signatures = cursor.bytes(signatureCount * 64);
	if (signatures.some((byte) => byte !== 0)) throw new Error("observation unavailable");

	const versionPrefix = cursor.byte();
	if (versionPrefix !== 0x80) throw new Error("observation unavailable");
	const requiredSignatures = cursor.byte();
	const readonlySigned = cursor.byte();
	const readonlyUnsigned = cursor.byte();
	const staticAccountCount = cursor.shortVec();
	if (
		requiredSignatures !== signatureCount ||
		requiredSignatures === 0 ||
		readonlySigned >= requiredSignatures ||
		staticAccountCount === 0 ||
		staticAccountCount > MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS ||
		requiredSignatures > staticAccountCount ||
		readonlyUnsigned > staticAccountCount - requiredSignatures
	) {
		throw new Error("observation unavailable");
	}

	const publicKeys = Array.from({ length: staticAccountCount }, () =>
		encodeBase58(cursor.bytes(32)),
	);
	cursor.bytes(32); // recent blockhash is decoded but deliberately not retained.

	const instructionCount = cursor.shortVec();
	if (instructionCount === 0) throw new Error("observation unavailable");
	const programIndexes = new Set<number>();
	for (let index = 0; index < instructionCount; index += 1) {
		const programIndex = cursor.byte();
		if (programIndex >= staticAccountCount) throw new Error("observation unavailable");
		programIndexes.add(programIndex);
		const accountIndexCount = cursor.shortVec();
		for (let account = 0; account < accountIndexCount; account += 1) {
			if (cursor.byte() >= staticAccountCount) throw new Error("observation unavailable");
		}
		cursor.bytes(cursor.shortVec());
	}

	const lookupCount = cursor.shortVec();
	if (lookupCount !== 0 || !cursor.done()) throw new Error("observation unavailable");

	const writableSignerCount = requiredSignatures - readonlySigned;
	const writableUnsignedCount =
		staticAccountCount - requiredSignatures - readonlyUnsigned;
	const accounts: MagicBlockCandidateAccount[] = publicKeys.map((publicKey, index) =>
		deepFreeze({
			publicKey,
			isSigner: index < requiredSignatures,
			isWritable:
				index < requiredSignatures
					? index < writableSignerCount
					: index - requiredSignatures < writableUnsignedCount,
			isProgram: programIndexes.has(index),
			isPayer: index === 0,
		}),
	);

	if (!accounts[0]?.isSigner || !accounts[0].isWritable || accounts[0].isProgram) {
		throw new Error("observation unavailable");
	}
	if (
		accounts.some(
			(account) => account.isProgram && (account.isSigner || account.isWritable),
		)
	) {
		throw new Error("observation unavailable");
	}

	return deepFreeze({
		candidate: deepFreeze({
			schemaVersion: "compass.magicblock-candidate/v1",
			cluster: "devnet",
			decodedPlan: deepFreeze({
				schemaVersion: "compass.decoded-action-plan/v1",
				actionKind: "account_delegation_review",
				accountIndexes: deepFreeze(accounts.map((_, index) => String(index))),
			}),
			accounts: deepFreeze(accounts),
		}),
	});
}

function decodeCanonicalBase64(value: string): Uint8Array {
	if (
		value.length === 0 ||
		value.length > 1_648 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new Error("observation unavailable");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw new Error("observation unavailable");
	return decoded;
}

function createCursor(bytes: Uint8Array) {
	let offset = 0;

	return {
		byte(): number {
			if (offset >= bytes.length) throw new Error("observation unavailable");
			return bytes[offset++] as number;
		},
		bytes(length: number): Uint8Array {
			if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
				throw new Error("observation unavailable");
			}
			const result = bytes.subarray(offset, offset + length);
			offset += length;
			return result;
		},
		shortVec(): number {
			let value = 0;
			let shift = 0;
			let encodedLength = 0;
			for (;;) {
				if (encodedLength === 3) throw new Error("observation unavailable");
				const byte = this.byte();
				value |= (byte & 0x7f) << shift;
				encodedLength += 1;
				if ((byte & 0x80) === 0) break;
				shift += 7;
			}
			if (
				value > 0x3fff ||
				(encodedLength > 1 && value < 1 << (7 * (encodedLength - 1)))
			) {
				throw new Error("observation unavailable");
			}
			return value;
		},
		done(): boolean {
			return offset === bytes.length;
		},
	};
}

function encodeBase58(bytes: Uint8Array): string {
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let index = 0; index < digits.length; index += 1) {
			carry += (digits[index] as number) << 8;
			digits[index] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	let leadingZeroes = 0;
	while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
	const prefix = "1".repeat(leadingZeroes);
	const encoded = digits
		.reverse()
		.map((digit) => BASE58_ALPHABET[digit])
		.join("");
	return prefix + (leadingZeroes === bytes.length ? "" : encoded);
}
