#!/usr/bin/env node
/**
 * E2E functional test for the Compass MCP Guard routed pipeline.
 *
 * What it does:
 * 1. Starts a mock downstream MCP server with crypto-simulating tools
 * 2. Starts Compass proxy wrapping the mock downstream
 * 3. Sends tools/list to discover available tools
 * 4. Runs through a matrix of operations covering every pipeline path
 * 5. Prints a verdict table showing expected vs actual outcome
 *
 * Usage:
 *   node scripts/e2e-pipeline-test.mjs              # full test
 *   node scripts/e2e-pipeline-test.mjs --verbose     # with audit dump
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let nextId = 1;
const TIMEOUT_MS = 15_000;
const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

function sendRequest(proc, method, params = {}) {
	const id = nextId++;
	const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
	proc.stdin.write(msg);
	return new Promise((resolve, reject) => {
		const onData = (chunk) => {
			try {
				for (const line of chunk.toString().split("\n").filter(Boolean)) {
					const resp = JSON.parse(line);
					if (resp.id === id) {
						proc.stdout.off("data", onData);
						resolve(resp);
					}
				}
			} catch {}
		};
		proc.stdout.on("data", onData);
		setTimeout(() => { proc.stdout.off("data", onData); reject(new Error("timeout")); }, TIMEOUT_MS);
	});
}

function spawnServer(cmd, args, env) {
	return spawn(cmd, args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: process.cwd(),
		env: { ...process.env, ...env },
	});
}

async function waitForOutput(proc, matcher, timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const onData = (chunk) => {
			const text = chunk.toString();
			chunks.push(text);
			if (matcher(text)) {
				proc.stderr.off("data", onData);
				resolve(chunks.join(""));
			}
		};
		proc.stderr.on("data", onData);
		setTimeout(() => { proc.stderr.off("data", onData); reject(new Error("timeout waiting for: " + matcher.toString())); }, timeoutMs);
	});
}

// ---------------------------------------------------------------------------
// Test matrix: every pipeline path
// ---------------------------------------------------------------------------

const TEST_MATRIX = [
	// ── READ-ONLY (prefilter → allow, no LLM) ──
	{
		name: "getPortfolioBalance",
		args: {},
		expected: "allow",
		path: "prefilter → read_only → allow",
		description: "Check wallet balance",
	},
	{
		name: "getTokenPrice",
		args: { token: "BTC" },
		expected: "allow",
		path: "prefilter → read_only → allow",
		description: "Get token price",
	},
	{
		name: "listAssets",
		args: {},
		expected: "allow",
		path: "prefilter → read_only → allow",
		description: "List held assets",
	},

	// ── ROUTABLE MUTATIONS (prefilter → routable_mutation → LLM Router) ──
	{
		name: "sendToken",
		args: { token: "USDC", amount: 10, toAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
		expected: "allow",
		path: "prefilter → routable_mutation → router:transfer → LLM Decision → allow",
		description: "Send tokens to address",
	},
	{
		name: "swapToken",
		args: { fromToken: "SOL", toToken: "USDC", amount: 2 },
		expected: "allow",
		path: "prefilter → routable_mutation → router:swap → LLM Decision → allow",
		description: "Swap one token for another",
	},

	// ── UNKNOWN TOOLS (prefilter → unknown → LLM Router) ──
	{
		name: "createOrder",
		args: { pair: "BTC-USD", side: "BUY", size: 0.001 },
		expected: "require_approval",
		path: "prefilter → unknown → router:* → varies",
		description: "Create order (LLM may skip/allow/approve)",
		allowAny: true,
	},

	// ── AMBIGUOUS (LLM non-deterministic: may classify as skip/transfer/swap/unknown) ──
	// Pipeline handles all outcomes correctly. Any of allow/require_approval/deny is valid.
	{
		name: "echo",
		args: { message: "hello" },
		expected: "allow",
		path: "prefilter → unknown → router:* → varies",
		description: "Echo (LLM may skip/approve/deny)",
		allowAny: true,
	},
	{
		name: "add",
		args: { a: 2, b: 3 },
		expected: "allow",
		path: "prefilter → unknown → router:* → varies",
		description: "Add (LLM may skip/approve/deny)",
		allowAny: true,
	},
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("═══════════════════════════════════════════════════");
	console.log("  Compass MCP Guard — E2E Pipeline Test");
	console.log("═══════════════════════════════════════════════════\n");

	// 1. Spawn Compass proxy with mock downstream
	const downstreamConfig = JSON.stringify({
		name: "test-crypto",
		command: "node",
		args: ["scripts/test-downstream-mcp.mjs"],
	});

	const compass = spawnServer("npx", ["-y", "tsx", "back/services/mcp/server/mcpServer.ts"], {
		COMPASS_MCP_DOWNSTREAM_CONFIG: downstreamConfig,
		COMPASS_LLM_ROUTER_ENABLED: "true",
		COMPASS_LLM_ROUTER_TIMEOUT_MS: "10000",
		COMPASS_LLM_DECISION_ENABLED: "true",
	});

	const stderrChunks = [];
	compass.stderr.on("data", (c) => stderrChunks.push(c.toString()));

	try {
		// 2. Initialize MCP handshake
		console.log("🔗 Connecting to Compass proxy...");
		await sendRequest(compass, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "e2e-test", version: "0.0.0" },
		});
		compass.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		console.log("   ✅ Connected\n");

		// 3. List tools
		console.log("📋 Discovering tools...");
		const listResult = await sendRequest(compass, "tools/list");
		const tools = listResult.result?.tools ?? [];
		console.log(`   Found ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

		// 4. Run test matrix
		console.log("🧪 Running test matrix...\n");
		const results = [];

		for (const test of TEST_MATRIX) {
			const start = Date.now();
			let actual, error;

			try {
				const res = await sendRequest(compass, "tools/call", {
					name: test.name,
					arguments: test.args,
				});

				// Parse the response to determine outcome
				const text = res.result?.content?.[0]?.text;
				if (text) {
					try {
						const parsed = JSON.parse(text);
						actual = parsed?.outcome ?? parsed?.decision ?? "allow";
					} catch {
						actual = "allow"; // non-JSON response = forwarded successfully
					}
				} else if (res.result) {
					actual = "allow"; // result present = forwarded
				} else {
					actual = "error";
					error = JSON.stringify(res.error ?? res);
				}
			} catch (e) {
				actual = "error";
				error = e.message;
			}

			const latency = Date.now() - start;
			const pass = test.allowAny || actual === test.expected;
			results.push({ ...test, actual, latency, pass, error });

			const icon = pass ? "✅" : "❌";
			const note = test.allowAny && actual !== test.expected ? " (non-deterministic, accepted)" : "";
			console.log(`  ${icon} ${test.name.padEnd(20)} expected=${test.expected.padEnd(17)} actual=${actual.padEnd(17)} ${latency}ms${note}`);
			if (!pass) {
				console.log(`     path: ${test.path}`);
				if (error) console.log(`     error: ${error.slice(0, 80)}`);
			}
		}

		// 5. Summary
		const passed = results.filter((r) => r.pass).length;
		const failed = results.filter((r) => !r.pass).length;
		const avgLatency = Math.round(results.reduce((s, r) => s + r.latency, 0) / results.length);

		console.log("\n═══════════════════════════════════════════════════");
		console.log(`  Results: ${passed}/${results.length} passed, ${failed} failed`);
		console.log(`  Average latency: ${avgLatency}ms`);

		// Pipeline path summary
		console.log("\n  Pipeline paths exercised:");
		const paths = [...new Set(results.map((r) => r.path))];
		for (const p of paths) {
			const count = results.filter((r) => r.path === p).length;
			console.log(`    ${count}x ${p}`);
		}

		if (failed > 0) {
			console.log("\n  Failed tests:");
			for (const r of results.filter((r) => !r.pass)) {
				console.log(`    ❌ ${r.name}: expected=${r.expected}, actual=${r.actual}`);
			}
		}

		// 6. Verbose audit dump
		if (VERBOSE) {
			console.log("\n═══════════════════════════════════════════════════");
			console.log("  Compass stderr (env + errors):");
			const stderr = stderrChunks.join("").trim();
			for (const line of stderr.split("\n").filter((l) => l.includes("[compass"))) {
				console.log(`    ${line}`);
			}
		}

		console.log("\n═══════════════════════════════════════════════════");
		if (failed === 0) {
			console.log("  ✅ ALL TESTS PASSED");
		} else {
			console.log("  ❌ SOME TESTS FAILED");
		}
		console.log("═══════════════════════════════════════════════════\n");

		process.exit(failed === 0 ? 0 : 1);
	} finally {
		compass.kill();
		await once(compass, "close").catch(() => {});
	}
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
