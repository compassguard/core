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
// The DB URL stays in this process.
//
// Exit codes — a script using this as an audit gate depends on them being distinct:
//   0  reconstructed AND every compared field matches the stored verdict
//   5  reconstructed but DIVERGED from what was stored (the interesting failure)
//   3  refused: the row predates the snapshot fields, so it cannot be re-derived
//   4  no such verdict
//   1  usage or internal error
//
// Opens the store with skipSchemaEnsure: a read tool must never run DDL. Without it,
// getByCorrelationId() would trigger CREATE TABLE + ~23 ADD COLUMN IF NOT EXISTS before the
// SELECT — which fails under a least-privilege read-only credential, and would migrate a
// production schema from a command that presents itself as read-only.
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

const store = createPgVerdictStore({ sql, skipSchemaEnsure: true });

// Because this tool never provisions, an unmigrated database surfaces here as a plain
// "relation does not exist". Report that as the actionable fact it is rather than a stack
// trace: the fix is to deploy (which migrates), not to run this differently.
let record;
try {
	record = await store.getByCorrelationId(correlationId);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/relation .* does not exist/i.test(message)) {
		fail(
			1,
			"the verdicts table does not exist in this database/schema. This tool never runs " +
				"migrations by design — deploy the service once to provision the schema, then retry.",
		);
	}
	fail(1, `database read failed: ${message}`);
}
if (!record) {
	fail(4, `no verdict found for correlation id ${correlationId}`);
}

const result = replayVerdict(record);

/**
 * Compare the WHOLE reproduced surface, not just the two decisions. `ok: true` means only that
 * the row carried enough fields to attempt a replay — it is not a verdict on whether the replay
 * MATCHED. An audit gate reading the exit status needs those to be different answers, and the
 * fields below are exactly what the reconstruction proof (verdictReplay.test.ts) asserts.
 */
function diffFields(): string[] {
	if (!result.ok) return [];
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const mismatched: string[] = [];
	if (result.deterministicDecision !== record.deterministicDecision) mismatched.push("deterministicDecision");
	if (result.decision !== record.decision) mismatched.push("decision");
	if (!same(result.reasons, record.reasons)) mismatched.push("reasons");
	if (!same(result.evaluatedRules, record.evaluatedRules)) mismatched.push("evaluatedRules");
	if (result.humanExplanation !== record.humanExplanation) mismatched.push("humanExplanation");
	if (result.judgeClamped !== record.judgeClamped) mismatched.push("judgeClamped");
	return mismatched;
}

const divergences = diffFields();
// 0 match · 5 diverged · 3 refused. Distinct because they mean different things to a caller.
const exitCode = !result.ok ? 3 : divergences.length > 0 ? 5 : 0;

/**
 * process.exit() can truncate an in-flight stdout write when stdout is a PIPE (`| jq`), which
 * would silently cut a large JSON record. Flush, close the pool, then exit.
 */
async function finish(code: number): Promise<never> {
	await new Promise<void>((resolve) => {
		if (process.stdout.write("")) resolve();
		else process.stdout.once("drain", () => resolve());
	});
	process.exit(code);
}

if (asJson) {
	process.stdout.write(
		`${JSON.stringify({ record, replay: result, divergences, matched: exitCode === 0 }, null, 2)}\n`,
	);
	await finish(exitCode);
}

/**
 * Stored verdict text is CALLER-SUPPLIED (statedPurpose, mandate text, recipient, rationale)
 * and its validators bound type and length, not content. Writing it raw to a terminal lets an
 * escape sequence clear the screen, move the cursor, or spoof this tool's own output — an
 * "✓ MATCHES" line an attacker wrote. Render C0/C1 controls visibly instead of executing them.
 * --json needs no equivalent: JSON.stringify escapes control characters.
 */
function escapeForTerminal(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
		if (ch === "\n") return "\\n";
		if (ch === "\t") return "\\t";
		return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

const line = (label: string, value: unknown) => {
	if (value === undefined || value === null) return;
	process.stdout.write(`  ${label.padEnd(22)} ${escapeForTerminal(String(value))}\n`);
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
	process.stdout.write(`  ${escapeForTerminal(result.reason)}\n\n`);
	await finish(3);
}

line("re-derived deterministic", result.deterministicDecision);
line("re-derived final", result.decision);
line("re-derived reasons", result.reasons.join(", "));
line("re-derived rules", result.evaluatedRules.join(", "));
if (divergences.length === 0) {
	process.stdout.write("  ✓ MATCHES the recorded verdict on every compared field\n");
} else {
	process.stdout.write(`  ✗ DIVERGES from the recorded verdict: ${divergences.join(", ")}\n`);
	for (const field of divergences) {
		const stored = (record as Record<string, unknown>)[field];
		const replayed = (result as Record<string, unknown>)[field];
		process.stdout.write(`      ${field}\n`);
		process.stdout.write(`        stored:   ${escapeForTerminal(JSON.stringify(stored) ?? "undefined")}\n`);
		process.stdout.write(`        replayed: ${escapeForTerminal(JSON.stringify(replayed) ?? "undefined")}\n`);
	}
}
if (result.engineVersionWarning) {
	process.stdout.write(`  ! ${result.engineVersionWarning}\n`);
}
process.stdout.write("\n");
await finish(exitCode);
