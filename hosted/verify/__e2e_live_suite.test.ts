/**
 * LIVE end-to-end suite — POST /v1/verify + /v1/verify/confirm against the REAL durable
 * backend (Supabase Postgres) and REAL devnet RPC.
 *
 * PLACE AT:  hosted/verify/__e2e_live_suite.test.ts   (in the durable worktree)
 * REQUIRES:  the durable VerdictStore (workstream C) landed on this branch, so that
 *            createHostedApp() with no injected store selects Postgres from the env var.
 *
 * RUN:
 *   COMPASS_VERDICT_DB_URL="postgres://...@...:6543/postgres" \
 *   SOLANA_RPC_URL="https://api.devnet.solana.com" \
 *   npx vitest --config vitest.back.config.ts run hosted/verify/__e2e_live_suite.test.ts
 *
 * The whole file SKIPS when COMPASS_VERDICT_DB_URL is unset (safe for normal CI).
 *
 * WHAT IT PROVES — everything below runs on real ARGS; NO on-chain decoder is required:
 *   A.  /verify produces a decision for varied real arg shapes, each persisted; cross-instance
 *       durability (#10): a SEPARATE app instance reads a verdict another instance wrote.
 *   A2. the durable Postgres row is really there (DECIDED + intended_effect from args).
 *   Val/Auth. requestedAt ISO validation (#12), missing-field 400, auth 401.
 *   B.  fail-closed confirm compare (#1/#2), execution_failed (#4), and #14a signature
 *       persistence + idempotent replay — via a CLEARLY-LABELED SIMULATED decoder (Fran's real
 *       deriveActualEffect is not landed, so the "actual" effect is fabricated; this exercises
 *       the compare LOGIC + close paths through the real endpoint, not a real on-chain flow).
 *       #14b (reject a replayed DIFFERENT signature → signature_mismatch) is now implemented
 *       in main and exercised here (previously it.skip'd while the guard was unbuilt).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import postgres from "postgres";

import { createHostedApp } from "../app";
import { createInMemoryVerdictStore } from "../verdict/verdictStore";
import type { VerdictStore } from "../verdict/verdictStore";
import { createVerifyService } from "./verifyService";
import { createVerifyConfirmService } from "./verifyConfirmService";
import type { ConfirmedTx, GetConfirmedTx } from "./getConfirmedTx";
import type { DeriveActualEffect } from "@shared/verdictContracts";

const DB_URL = process.env.COMPASS_VERDICT_DB_URL;
const LIVE = Boolean(DB_URL);
const API_KEY = "e2e-key";

// ── Postgres schema knobs — SET THESE to C's actual migration before running section A2 ──
const TABLE = process.env.COMPASS_VERDICT_TABLE ?? "verdicts";
const COL = { id: "correlation_id", status: "status", intended: "intended_effect" } as const;

const HEALTH = { dependencies: { auditStore: "ok", policy: "ok", llm: "ok" } as const };
// prepare:false + bounded pool are required for the Supabase transaction pooler (port 6543).
const sql = LIVE ? postgres(DB_URL as string, { prepare: false, max: 1 }) : null;
afterAll(async () => {
	await sql?.end();
});

/** App with NO injected store → app.ts selects the env store (durable when DB_URL set). */
function liveApp() {
	return createHostedApp({ auth: { apiKey: API_KEY }, health: HEALTH });
}

function post(
	app: ReturnType<typeof liveApp>,
	path: string,
	body: unknown,
	opts: { auth?: boolean } = {},
) {
	const auth = opts.auth ?? true;
	return app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(auth ? { authorization: `Bearer ${API_KEY}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// A · decisions + cross-instance durability + validation/auth  (real args, no decoder)
// ─────────────────────────────────────────────────────────────────────────────
describe.runIf(LIVE)("A · /verify decisions + cross-instance durability", () => {
	const appA = liveApp(); // writer
	const appB = liveApp(); // reader — a SEPARATE instance, same Postgres
	let devnetSig =
		"1111111111111111111111111111111111111111111111111111111111111111"; // dummy fallback
	let sigIsReal = false;

	beforeAll(async () => {
		try {
			const conn = new Connection(
				process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
				"confirmed",
			);
			const sigs = await conn.getSignaturesForAddress(
				new PublicKey("Vote111111111111111111111111111111111111111"),
				{ limit: 1 },
			);
			if (sigs[0]?.signature) {
				devnetSig = sigs[0].signature;
				sigIsReal = true;
			}
		} catch {
			/* keep dummy → confirm returns `unconfirmed` instead of `unverified_no_decoder` */
		}
		console.log(
			`[e2e] devnet signature: ${sigIsReal ? `real ${devnetSig.slice(0, 8)}…` : "unavailable → dummy (confirm → unconfirmed)"}`,
		);
	}, 20_000);

	const SCENARIOS = [
		{
			name: "clean known-recipient transfer",
			body: {
				toolName: "solana_transfer",
				intent: { kind: "transfer" },
				arguments: {
					recipient: "Rcpt1111KnownGood",
					amountUsd: 12,
					recipientKnown: true,
				},
			},
		},
		{
			name: "suspicious high-amount transfer",
			body: {
				toolName: "solana_transfer",
				intent: { kind: "transfer" },
				arguments: {
					recipient: "Stranger9999",
					amountUsd: 999,
					suspiciousRecipient: true,
				},
			},
		},
		{
			name: "swap unknown token",
			body: {
				toolName: "jupiter_swap",
				intent: { kind: "swap" },
				arguments: { amountUsd: 250, tokenMint: "ScamMint1111", tokenKnown: false },
			},
		},
		{ name: "unknown tool, no intent", body: { toolName: "mystery_tool", arguments: {} } },
	];

	for (const s of SCENARIOS) {
		it(`verify → decision + cross-instance read: ${s.name}`, async () => {
			const res = await post(appA, "/v1/verify", s.body);
			expect(res.status).toBe(200);
			const verdict = await res.json();
			expect(verdict.correlationId).toBeTruthy();
			expect(["allow", "deny", "review"]).toContain(verdict.decision);
			expect(["low", "medium", "high", "unknown"]).toContain(verdict.riskLevel);
			expect(Array.isArray(verdict.reasons)).toBe(true);
			expect(typeof verdict.humanExplanation).toBe("string");
			console.log(
				`[e2e] ${s.name} → decision=${verdict.decision} risk=${verdict.riskLevel}`,
			);

			// #10: a SEPARATE app instance finds the record — via Postgres, not shared memory.
			// `unknown_correlation` would mean the durable store is NOT wired.
			const conf = await post(appB, "/v1/verify/confirm", {
				correlationId: verdict.correlationId,
				txSignature: devnetSig,
			});
			expect(conf.status).toBe(200);
			const confBody = await conf.json();
			expect(confBody.outcome).not.toBe("unknown_correlation");
			expect(["unverified_no_decoder", "unconfirmed"]).toContain(confBody.outcome);
			console.log(`[e2e] ${s.name} → cross-instance confirm=${confBody.outcome}`);
		}, 25_000);
	}

	it("no Authorization → 401", async () => {
		const res = await post(appA, "/v1/verify", { toolName: "solana_transfer" }, { auth: false });
		expect(res.status).toBe(401);
	});

	it("wrong bearer → 401", async () => {
		const res = await appA.request("/v1/verify", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer wrong" },
			body: "{}",
		});
		expect(res.status).toBe(401);
	});

	it("missing toolName → 400", async () => {
		const res = await post(appA, "/v1/verify", { arguments: {} });
		expect(res.status).toBe(400);
	});

	it("non-ISO requestedAt → 400 (#12)", async () => {
		const res = await post(appA, "/v1/verify", {
			toolName: "solana_transfer",
			requestedAt: "not-a-date",
		});
		expect(res.status).toBe(400);
	});

	it("valid ISO requestedAt → 200 (#12)", async () => {
		const res = await post(appA, "/v1/verify", {
			toolName: "solana_transfer",
			intent: { kind: "transfer" },
			arguments: { recipient: "R", amountUsd: 1 },
			requestedAt: "2026-07-07T00:00:00.000Z",
		});
		expect(res.status).toBe(200);
	});

	it("confirm with an unissued correlationId → unknown_correlation", async () => {
		const res = await post(appB, "/v1/verify/confirm", {
			correlationId: "does-not-exist-0000",
			txSignature: devnetSig,
		});
		expect(res.status).toBe(200);
		expect((await res.json()).outcome).toBe("unknown_correlation");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 · durable Postgres row inspection  (SET TABLE/COL above to your migration first)
// ─────────────────────────────────────────────────────────────────────────────
describe.runIf(LIVE)("A2 · durable Postgres row inspection", () => {
	it("verify persists a DECIDED row with intended_effect built from the args", async () => {
		const app = liveApp();
		const res = await post(app, "/v1/verify", {
			toolName: "solana_transfer",
			intent: { kind: "transfer" },
			arguments: { recipient: "RowCheck7777", amountUsd: 42 },
		});
		const { correlationId } = await res.json();

		const rows = await sql!`
			select ${sql!(COL.status)} as status, ${sql!(COL.intended)} as intended
			from ${sql!(TABLE)}
			where ${sql!(COL.id)} = ${correlationId}`;
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe("DECIDED");
		// The porsager `postgres` driver returns jsonb as a raw JSON string (the same reason
		// C's rowToRecord carries parseJsonb) — parse before asserting on the structured effect.
		const intended =
			typeof rows[0].intended === "string"
				? JSON.parse(rows[0].intended as string)
				: rows[0].intended;
		expect(intended.recipient).toBe("RowCheck7777");
		expect(intended.amountUsd).toBe(42);
		console.log(
			`[e2e] Postgres row: status=${rows[0].status} intended=${JSON.stringify(intended)}`,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// B · fail-closed confirm compare  (SIMULATED decoder — the "actual" effect is fabricated)
// Default store is in-memory (decoupled from C's durable API); the compare logic is
// store-agnostic. To ALSO prove the durable close (CONFIRMED_* + tx_signature persisted via
// the endpoint — the gap the C run flagged), swap makeStore() for C's durable factory.
// ─────────────────────────────────────────────────────────────────────────────
const makeStore = (): VerdictStore => createInMemoryVerdictStore();
const OK_TX = { meta: { err: null } } as unknown as ConfirmedTx;
const FAILED_TX = { meta: { err: "InstructionError" } } as unknown as ConfirmedTx;

function attackApp(
	deriveActualEffect: DeriveActualEffect,
	getConfirmedTx: GetConfirmedTx = async () => OK_TX,
) {
	const store = makeStore();
	const app = createHostedApp({
		auth: { apiKey: API_KEY },
		health: HEALTH,
		// #15 guard (app.ts): inject BOTH verify + confirm, or neither — never a partial
		// injection that would split-brain across two stores. Both share `store`.
		verdictStore: store,
		verifications: createVerifyService({ verdictStore: store }),
		confirmations: createVerifyConfirmService({ verdictStore: store, getConfirmedTx, deriveActualEffect }),
	});
	return { store, app };
}

async function seed(app: ReturnType<typeof liveApp>, recipient = "RcptCompare1111") {
	const res = await post(app, "/v1/verify", {
		toolName: "solana_transfer",
		intent: { kind: "transfer" },
		arguments: { recipient, amountUsd: 10 },
	});
	return (await res.json()).correlationId as string;
}

describe.runIf(LIVE)("B · fail-closed confirm compare (simulated decoder)", () => {
	it("matching effect → match, CONFIRMED_MATCH (#6)", async () => {
		const { store, app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			extraInstructions: [],
		}));
		const id = await seed(app);
		const res = await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-match" });
		expect((await res.json()).outcome).toBe("match");
		expect((await store.getByCorrelationId(id))?.status).toBe("CONFIRMED_MATCH");
	});

	it("over-amount to approved recipient → mismatch (#1)", async () => {
		const { app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			lamports: 5_000_000_000, // intent declared no native amount → undeclared-but-executed
			extraInstructions: [],
		}));
		const id = await seed(app);
		const res = await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-over" });
		expect((await res.json()).outcome).toBe("mismatch");
	});

	it("different mint, same recipient → mismatch (#2)", async () => {
		const { app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			mint: "ScamMintXXXX",
			extraInstructions: [],
		}));
		const id = await seed(app);
		const res = await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-mint" });
		expect((await res.json()).outcome).toBe("mismatch");
	});

	it("extra instruction (SetAuthority) → mismatch", async () => {
		const { app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			extraInstructions: ["SetAuthority"],
		}));
		const id = await seed(app);
		const res = await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-extra" });
		const body = await res.json();
		expect(body.outcome).toBe("mismatch");
		expect(body.discrepancies).toContainEqual({ field: "extra_instruction", actual: "SetAuthority" });
	});

	it("confirmed-but-failed tx (meta.err) → execution_failed, closed (#4)", async () => {
		const { store, app } = attackApp(
			(_tx, intended) => ({ unavailable: false, recipient: intended.recipient, extraInstructions: [] }),
			async () => FAILED_TX,
		);
		const id = await seed(app);
		const res = await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-failed" });
		expect((await res.json()).outcome).toBe("execution_failed");
		expect((await store.getByCorrelationId(id))?.status).toBe("CONFIRMED_MISMATCH");
	});

	it("persists the tx signature + idempotent same-signature replay via the endpoint (#14a)", async () => {
		const { store, app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			extraInstructions: [],
		}));
		const id = await seed(app);
		expect((await (await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-A" })).json()).outcome).toBe("match");
		expect((await store.getByCorrelationId(id))?.txSignature).toBe("sig-A"); // #14a persisted via endpoint
		expect((await (await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-A" })).json()).outcome).toBe("match"); // idempotent same-sig replay
	});

	// #14b — the replay-protection guard has landed in main: the confirm service's already-closed
	// path now compares the incoming txSignature against the persisted one and returns
	// `signature_mismatch` when they differ, instead of the fail-OPEN cached `match`. This
	// exercises that guard end-to-end.
	it("replayed DIFFERENT signature on a closed correlation → signature_mismatch (#14b)", async () => {
		const { store, app } = attackApp((_tx, intended) => ({
			unavailable: false,
			recipient: intended.recipient,
			extraInstructions: [],
		}));
		const id = await seed(app);
		expect((await (await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-A" })).json()).outcome).toBe("match");
		expect((await store.getByCorrelationId(id))?.txSignature).toBe("sig-A");
		expect((await (await post(app, "/v1/verify/confirm", { correlationId: id, txSignature: "sig-B" })).json()).outcome).toBe("signature_mismatch");
	});
});
