import { createHash } from "node:crypto";

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function hasExactKeys(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (!isPlainRecord(value)) return false;
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function isDigest(value: unknown): value is string {
	return typeof value === "string" && HEX_DIGEST.test(value);
}

export function isOpaqueIdentifier(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_IDENTIFIER.test(value);
}

export function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !RFC3339_MILLISECONDS.test(value)) return false;
	return new Date(value).toISOString() === value;
}

export function canonicalJson(value: unknown): string {
	return serializeCanonical(value, new Set<object>());
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)) {
			for (let index = 0; index < value.length; index += 1) {
				const code = value.charCodeAt(index);
				if (code >= 0xd800 && code <= 0xdbff) {
					const next = value.charCodeAt(index + 1);
					if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid Unicode");
					index += 1;
				} else if (code >= 0xdc00 && code <= 0xdfff) {
					throw new Error("invalid Unicode");
				}
			}
		}
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("cyclic value");
		ancestors.add(value);
		const serialized = `[${value.map((entry) => serializeCanonical(entry, ancestors)).join(",")}]`;
		ancestors.delete(value);
		return serialized;
	}
	if (!isPlainRecord(value)) throw new Error("unsupported canonical value");
	if (ancestors.has(value)) throw new Error("cyclic value");
	ancestors.add(value);
	const serialized = `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key], ancestors)}`)
		.join(",")}}`;
	ancestors.delete(value);
	return serialized;
}

export function sha256Hex(...parts: readonly (string | Uint8Array)[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
}

export function parseClosedJson(text: string): unknown {
	assertNoDuplicateJsonMembers(text);
	return JSON.parse(text);
}

export function assertNoDuplicateJsonMembers(text: string): void {
	const maximumDepth = 32;
	const maximumValueTokens = 256;
	let index = 0;
	let valueTokens = 0;

	function whitespace() {
		while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
	}

	function stringToken(): string {
		const start = index;
		if (text[index] !== '"') throw new Error("expected JSON string");
		index += 1;
		while (index < text.length) {
			const character = text[index];
			if (character === '"') {
				index += 1;
				return JSON.parse(text.slice(start, index));
			}
			if (character === "\\") {
				index += 1;
				if (text[index] === "u") {
					if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
						throw new Error("invalid JSON escape");
					}
					index += 5;
					continue;
				}
				if (!/["\\/bfnrt]/.test(text[index] ?? "")) throw new Error("invalid JSON escape");
			}
			if ((text.charCodeAt(index) ?? 0) < 0x20) throw new Error("invalid JSON string");
			index += 1;
		}
		throw new Error("unterminated JSON string");
	}

	function value(depth: number) {
		if (depth > maximumDepth || ++valueTokens > maximumValueTokens) {
			throw new Error("JSON complexity limit exceeded");
		}
		whitespace();
		const character = text[index];
		if (character === "{") return object(depth);
		if (character === "[") return array(depth);
		if (character === '"') {
			stringToken();
			return;
		}
		const remainder = text.slice(index);
		const token = remainder.match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
		if (!token) throw new Error("invalid JSON value");
		index += token.length;
	}

	function object(depth: number) {
		const keys = new Set<string>();
		index += 1;
		whitespace();
		if (text[index] === "}") {
			index += 1;
			return;
		}
		for (;;) {
			whitespace();
			const key = stringToken();
			if (keys.has(key)) throw new Error(`duplicate JSON member: ${key}`);
			keys.add(key);
			whitespace();
			if (text[index] !== ":") throw new Error("expected JSON colon");
			index += 1;
			value(depth + 1);
			whitespace();
			if (text[index] === "}") {
				index += 1;
				return;
			}
			if (text[index] !== ",") throw new Error("expected JSON comma");
			index += 1;
		}
	}

	function array(depth: number) {
		index += 1;
		whitespace();
		if (text[index] === "]") {
			index += 1;
			return;
		}
		for (;;) {
			value(depth + 1);
			whitespace();
			if (text[index] === "]") {
				index += 1;
				return;
			}
			if (text[index] !== ",") throw new Error("expected JSON comma");
			index += 1;
		}
	}

	whitespace();
	value(0);
	whitespace();
	if (index !== text.length) throw new Error("trailing JSON content");
}

export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
