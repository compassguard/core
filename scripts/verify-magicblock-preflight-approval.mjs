import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const defaultRoot = resolve(import.meta.dirname, "..");
const root = process.argv[2] === "--root" ? resolve(process.argv[3] ?? "") : defaultRoot;
const approvalPath = resolve(root, "docs/magicblock-devnet-preflight/strategic-baseline-approval.json");
const required = ["status", "owner", "reviewerId", "decision", "securityReview", "recordedAt", "approvalEvidence"];

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
	return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
if (!hasExactKeys(approval, required)) throw new Error("strategic-baseline approval record has an invalid schema");
if (approval.status !== "pending") throw new Error('internal strategic-baseline proposal metadata must remain "pending" until immutable Board approval evidence is available');
if (approval.owner !== "Board" || approval.reviewerId !== "Board") throw new Error("internal strategic-baseline proposal metadata owner is invalid");
if (approval.decision !== null || approval.securityReview !== null || approval.recordedAt !== null || approval.approvalEvidence !== null) {
	throw new Error("internal strategic-baseline proposal metadata cannot contain approval evidence");
}

throw new Error("immutable Board approval evidence is required; local proposal metadata is non-authoritative and cannot authorize strategic or external action");
