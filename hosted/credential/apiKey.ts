import { createHash, randomBytes } from "node:crypto";

/**
 * Mint a fresh per-email opaque Bearer API key (D2/D14). The `compass_` prefix makes the
 * token self-identifying in logs/config; the 32 random bytes are high-entropy, so a fast
 * hash (hashApiKey) is the correct storage form — bcrypt/argon2 are for low-entropy passwords.
 * The raw key is returned once and never persisted or logged.
 */
export function generateApiKey(): string {
	return `compass_${randomBytes(32).toString("base64url")}`;
}

/** Hash a raw API key to the form the credential store persists and looks up (SHA-256 hex). */
export function hashApiKey(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}
