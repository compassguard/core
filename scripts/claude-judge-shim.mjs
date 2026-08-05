#!/usr/bin/env node
/**
 * Claude chat-completions shim — a local OpenAI-wire-shaped endpoint backed by `claude -p`.
 *
 * Sibling of scripts/codex-judge-shim.mjs, same contract, different CLI behind it. Use either
 * one to run the live judge suites against a real model; they are interchangeable because both
 * speak the subset of POST /v1/chat/completions that hosted/llm/llmDecisionAdapter.ts uses.
 *
 * Adapter contract honored (llmDecisionAdapter.ts:200-246):
 *   - reads body.messages[0].content (system) and body.messages[1].content (user)
 *   - requires response.ok, else the judge degrades to judge_unavailable
 *   - reads choices[0].message.content and JSON.parse()s it
 *
 * TWO DIFFERENCES FROM THE CODEX SHIM, both consequences of `claude -p` being a coding AGENT
 * rather than a bare model endpoint:
 *
 *  1. It has its own system prompt and will REFUSE a prompt that reads as "emit a canned
 *     authorization verdict". Probed 2026-08-05: a bare "respond with this JSON object" ask was
 *     declined ("there's no actual task ... to evaluate"), while a realistic mandate+action
 *     payload judged correctly (DENY, four reason codes). Real judge traffic carries the
 *     mandate, so this is fine — but a synthetic smoke test with an empty payload may get a
 *     refusal, which surfaces here as a 502 (unparseable), never as an invented verdict.
 *  2. The prompt goes over STDIN, not argv: --disallowed-tools is variadic and swallows a
 *     trailing positional prompt ("Input must be provided either through stdin or as a prompt
 *     argument").
 *
 * Containment mirrors the codex shim: a throwaway empty cwd plus every filesystem/network/
 * subagent tool disallowed, so the untrusted statedPurpose/args in the prompt reach a loop with
 * no repo context to read and nothing to mutate. --strict-mcp-config with no --mcp-config drops
 * the operator's MCP servers. --max-turns 1 forbids an agentic loop: one judgment, one answer.
 *
 * RUN (shim first, then a live suite):
 *   node scripts/claude-judge-shim.mjs &                      # port 8787
 *   COMPASS_JUDGE_SHIM_URL=http://127.0.0.1:8787 \
 *   npx vitest --config vitest.back.config.ts --run hosted/verify/__live_reconstruction.test.ts
 *
 * Knobs:
 *   PORT=<n>            listen port (default 8787)
 *   CLAUDE_MODEL=<id>   default claude-sonnet-5; the judge is a small classification task
 *   FAIL_MODE=auth      always answer 401, exercising the adapter's !response.ok branch
 *   LOG_PATH=<file>     append every exchange as JSONL (includes prompts + verdicts)
 *   CLAUDE_TIMEOUT_MS   default 180000
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const FAIL_MODE = process.env.FAIL_MODE ?? "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
const LOG_PATH = process.env.LOG_PATH ?? "";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 180000);

/** Tools the judge must never reach. The prompt carries untrusted caller-supplied text. */
const DISALLOWED_TOOLS = [
	"Bash",
	"Edit",
	"Write",
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"Task",
	"NotebookEdit",
];

function log(entry) {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		/* logging must never break the shim */
	}
}

/** Run one `claude -p`; resolve its final assistant text (or reject). */
function runClaude(prompt) {
	return new Promise((resolve, reject) => {
		const workspace = mkdtempSync(join(tmpdir(), "claude-shim-"));
		const args = [
			"-p",
			"--output-format",
			"json",
			"--model",
			CLAUDE_MODEL,
			"--max-turns",
			"1",
			"--strict-mcp-config",
			"--disallowed-tools",
			...DISALLOWED_TOOLS,
		];

		const child = spawn("claude", args, {
			cwd: workspace,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`claude -p timed out after ${CLAUDE_TIMEOUT_MS}ms`));
		}, CLAUDE_TIMEOUT_MS);

		child.on("error", (err) => {
			clearTimeout(timer);
			rmSync(workspace, { recursive: true, force: true });
			reject(err);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			rmSync(workspace, { recursive: true, force: true });
			if (code !== 0) {
				reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
				return;
			}
			// --output-format json wraps the reply: { result, is_error, total_cost_usd, ... }.
			let envelope;
			try {
				envelope = JSON.parse(stdout);
			} catch {
				reject(new Error(`claude -p stdout was not JSON: ${stdout.slice(0, 300)}`));
				return;
			}
			if (envelope.is_error) {
				reject(new Error(`claude -p reported is_error: ${String(envelope.result).slice(0, 300)}`));
				return;
			}
			resolve({ text: String(envelope.result ?? ""), costUsd: envelope.total_cost_usd });
		});

		child.stdin.end(prompt);
	});
}

/**
 * Pull a JSON object out of a model reply: exact parse, then fenced block, then the
 * widest brace span. Identical to the codex shim's extractor.
 */
function extractJson(text) {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		/* fall through */
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		try {
			return JSON.parse(fenced[1].trim());
		} catch {
			/* fall through */
		}
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

const server = createServer((req, res) => {
	if (req.method !== "POST") {
		res.writeHead(405).end();
		return;
	}

	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", async () => {
		const startedAt = Date.now();

		// No API key exists on this path (stored login), so a "bad key" is simulated at the
		// transport layer. The adapter cannot tell the difference — both are !response.ok.
		if (FAIL_MODE === "auth") {
			log({ at: new Date().toISOString(), failMode: "auth", status: 401 });
			res
				.writeHead(401, { "Content-Type": "application/json" })
				.end(JSON.stringify({ error: { type: "AuthError", message: "simulated bad key" } }));
			return;
		}

		let parsedBody;
		try {
			parsedBody = JSON.parse(body);
		} catch {
			res.writeHead(400).end();
			return;
		}

		const systemContent = parsedBody?.messages?.[0]?.content ?? "";
		const userContent = parsedBody?.messages?.[1]?.content ?? "";

		// The adapter JSON.parse()s choices[0].message.content, so the reply must be a bare
		// JSON object. There is no response_format flag on the CLI, so the instruction rides
		// in the prompt (the schema_prompt pattern), same as the codex shim.
		const prompt = [
			systemContent,
			"",
			"Respond with ONLY a single JSON object and nothing else — no prose, no code fences, no explanation.",
			'Shape: {"decision": "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL" | "REQUIRE_ADDITIONAL_CONTEXT", "confidence": <number 0-1>, "reasonCodes": [<short UPPER_SNAKE_CASE strings>], "rationale": "<one or two sentences>"}',
			"",
			"Request to judge (JSON):",
			userContent,
		].join("\n");

		try {
			const { text, costUsd } = await runClaude(prompt);
			const parsed = extractJson(text);
			const elapsedMs = Date.now() - startedAt;

			if (parsed === undefined) {
				// Unparseable reply (including a refusal): answer 502 so the adapter degrades
				// honestly rather than the shim inventing a verdict the model never gave.
				log({ at: new Date().toISOString(), elapsedMs, error: "unparseable", raw: text.slice(0, 1000) });
				res
					.writeHead(502, { "Content-Type": "application/json" })
					.end(JSON.stringify({ error: { message: "claude reply was not JSON" } }));
				return;
			}

			log({
				at: new Date().toISOString(),
				elapsedMs,
				costUsd,
				model: CLAUDE_MODEL,
				request: (() => {
					try {
						return JSON.parse(userContent);
					} catch {
						return userContent;
					}
				})(),
				verdict: parsed,
			});

			res.writeHead(200, { "Content-Type": "application/json" }).end(
				JSON.stringify({
					id: "claude-shim",
					object: "chat.completion",
					model: CLAUDE_MODEL,
					choices: [
						{ index: 0, message: { role: "assistant", content: JSON.stringify(parsed) }, finish_reason: "stop" },
					],
				}),
			);
		} catch (error) {
			const elapsedMs = Date.now() - startedAt;
			log({ at: new Date().toISOString(), elapsedMs, error: String(error) });
			res
				.writeHead(502, { "Content-Type": "application/json" })
				.end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
});

server.listen(PORT, "127.0.0.1", () => {
	process.stdout.write(
		`claude-judge-shim listening on http://127.0.0.1:${PORT} (model=${CLAUDE_MODEL}, failMode=${FAIL_MODE || "none"})\n`,
	);
});
