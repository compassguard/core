#!/usr/bin/env -S npx tsx
// Verdict reconstruction CLI — NOT deployed, never internet-facing.
//
// Re-derives a stored verdict from its own row and prints what the decider saw. There is
// deliberately no hosted GET /v1/verdicts route: a verdict row carries the owner's private
// mandate text, their email, the stated purpose, the recipient and the amount — and the /v1
// middleware admits ANY per-email credential while /signup mints those publicly, so a hosted
// route would expose every user's verdicts to every other user (see hosted/app.ts:105-109,
// which records the same reasoning for metrics). Whoever can legitimately reconstruct a verdict
// already has DB access, so the endpoint buys nothing and costs an auth gate maintained forever.
// Decision recorded as R2 in docs/plans/2026-08-05-reconstruction-read-surface.md.
//
// Usage:
//   COMPASS_VERDICT_DB_URL='<supabase pooler url>' npm run replay -- <correlation-id>
//   COMPASS_VERDICT_DB_URL='…' npm run replay -- <correlation-id> --json
//
// The DB URL stays in this process. Exit codes: 0 reconstructed, 3 refused (not
// reconstructable), 4 not found, 1 usage or internal error.
import { createSqlExecutorFromEnv } from "../hosted/db/sqlExecutorFromEnv";
import { createPgVerdictStore } from "../hosted/verdict/verdictStorePg";
import { replayVerdict } from "../hosted/verdict/verdictReplay";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const correlationId = args.find((a) => !a.startsWith("--"));

function fail(code: number, message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

if (!correlationId) {
	fail(1, "usage: npm run replay -- <correlation-id> [--json]");
}

const sql = createSqlExecutorFromEnv();
if (!sql) {
	fail(1, "COMPASS_VERDICT_DB_URL is not set — point it at the Supabase pooler URL.");
}

const store = createPgVerdictStore({ sql });
const record = await store.getByCorrelationId(correlationId);
if (!record) {
	fail(4, `no verdict found for correlation id ${correlationId}`);
}

const result = replayVerdict(record);

if (asJson) {
	process.stdout.write(`${JSON.stringify({ record, replay: result }, null, 2)}\n`);
	process.exit(result.ok ? 0 : 3);
}

const line = (label: string, value: unknown) => {
	if (value === undefined || value === null) return;
	process.stdout.write(`  ${label.padEnd(22)} ${String(value)}\n`);
};

process.stdout.write(`\nVERDICT ${record.correlationId}\n`);
process.stdout.write(`${"─".repeat(72)}\n`);
process.stdout.write("WHAT THE DECIDER SAW\n");
line("decided at", record.decidedAt);
line("caller", record.authenticatedEmail ?? record.userId);
line("stated purpose", record.statedPurpose ?? "(none given)");
line("mandate", record.mandateSnapshot?.mandateText ?? "(no mandate found)");
line("tool", record.toolName);
line("classification", record.toolClassification?.riskClass);
line("amount (usd)", record.policyContext?.amount_usd);
line("recipient", record.policyContext?.recipient_address);
line("recipient known", record.policyContext?.recipient_known);

process.stdout.write("\nRULE\n");
line("policy", `${record.policyId ?? "?"}@${record.policyVersion ?? "?"}`);
line("transfer cap (usd)", record.policySnapshot?.transfers?.max_usd_without_approval);
line("rules evaluated", record.evaluatedRules?.join(", "));
line("engine build", record.engineVersion ?? "(not recorded)");

if (record.judgeModel !== undefined || record.judgeRawDecision !== undefined) {
	process.stdout.write("\nMODEL\n");
	line("judge model", record.judgeModel);
	line("raw decision", record.judgeRawDecision);
	line("confidence", record.judgeConfidence);
	line("clamped", record.judgeClamped);
	line("reason codes", record.judgeReasonCodes?.join(", "));
	line("rationale", record.judgeRationale);
} else {
	process.stdout.write("\nMODEL\n  (no judge ran — deterministic only)\n");
}

process.stdout.write("\nDECISION AS RECORDED\n");
line("deterministic", record.deterministicDecision);
line("final", record.decision);
line("reasons", record.reasons.join(", "));
line("explanation", record.humanExplanation);

process.stdout.write("\nRECONSTRUCTION\n");
if (!result.ok) {
	// A refusal is a VALUE, not a crash (plan R3): rows written before the snapshot fields
	// existed cannot be re-derived, and saying so precisely beats a stack trace.
	process.stdout.write(`  NOT RECONSTRUCTABLE (missing ${result.missingField})\n`);
	process.stdout.write(`  ${result.reason}\n\n`);
	process.exit(3);
}

const agrees =
	result.deterministicDecision === record.deterministicDecision &&
	result.decision === record.decision;
line("re-derived deterministic", result.deterministicDecision);
line("re-derived final", result.decision);
line("re-derived reasons", result.reasons.join(", "));
process.stdout.write(
	`  ${agrees ? "✓ MATCHES the recorded verdict" : "✗ DIVERGES from the recorded verdict"}\n`,
);
if (result.engineVersionWarning) {
	process.stdout.write(`  ! ${result.engineVersionWarning}\n`);
}
process.stdout.write("\n");
process.exit(agrees ? 0 : 3);
