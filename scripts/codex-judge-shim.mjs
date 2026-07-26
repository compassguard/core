#!/usr/bin/env node
/**
 * Codex chat-completions shim — a local OpenAI-wire-shaped endpoint backed by `codex exec`.
 *
 * Why this exists: the verify mandate judge reaches its provider over HTTP
 * (hosted/llm/llmDecisionAdapter.ts -> callChatCompletionsEndpoint). Codex has no HTTP
 * endpoint; it is a CLI with a stored browser login. This shim speaks the subset of
 * POST /v1/chat/completions that the adapter actually uses, and fulfils each request by
 * shelling out to `codex exec`. The app under test is therefore byte-identical to what
 * ships: provider stays "opencode-go", only COMPASS_LLM_BASE_URL points here.
 *
 * Adapter contract honored (llmDecisionAdapter.ts:200-246):
 *   - reads body.messages[0].content (system) and body.messages[1].content (user)
 *   - requires response.ok, else the judge degrades to judge_unavailable
 *   - reads choices[0].message.content and JSON.parse()s it
 *
 * Containment mirrors scope-agent's CodexProvider: --sandbox read-only and a throwaway
 * empty cwd, so the untrusted statedPurpose/args in the prompt reach a tool loop with no
 * repo context to read and nothing to mutate. --skip-git-repo-check because the temp cwd
 * is not a git repo. Exec mode is non-interactive: escalation fails rather than prompts.
 *
 * Test-only knobs (drive the adapter's failure paths without a real credential):
 *   FAIL_MODE=auth  -> always answer 401, exercising the !response.ok branch (Case I)
 *   CODEX_MODEL=<id> -> pass --model; omit to use the account default (gpt-5.5)
 *
 * Every exchange is appended to LOG_PATH as JSONL for the results file.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const FAIL_MODE = process.env.FAIL_MODE ?? "";
const CODEX_MODEL = process.env.CODEX_MODEL ?? "";
const LOG_PATH = process.env.LOG_PATH ?? "";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS ?? 180000);

function log(entry) {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		/* logging must never break the shim */
	}
}

/** Run one `codex exec`; resolve the final agent message (or reject). */
function runCodex(prompt) {
	return new Promise((resolve, reject) => {
		const workspace = mkdtempSync(join(tmpdir(), "codex-shim-"));
		const lastMessagePath = join(workspace, "last-message.txt");
		const args = [
			"exec",
			"--skip-git-repo-check",
			"--sandbox",
			"read-only",
			"--output-last-message",
			lastMessagePath,
		];
		if (CODEX_MODEL) args.push("--model", CODEX_MODEL);
		args.push(prompt);

		const child = spawn("codex", args, {
			cwd: workspace,
			// Codex reads stdin when the prompt arg is absent; we pass it as an arg, so
			// close stdin to stop it waiting on a pipe that never gets written.
			stdio: ["ignore", "pipe", "pipe"],
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
			reject(new Error(`codex exec timed out after ${CODEX_TIMEOUT_MS}ms`));
		}, CODEX_TIMEOUT_MS);

		child.on("error", (err) => {
			clearTimeout(timer);
			rmSync(workspace, { recursive: true, force: true });
			reject(err);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			let lastMessage = "";
			try {
				lastMessage = readFileSync(lastMessagePath, "utf8").trim();
			} catch {
				/* fall back to stdout span-extraction below */
			}
			rmSync(workspace, { recursive: true, force: true });
			if (code !== 0) {
				reject(new Error(`codex exec exited ${code}: ${stderr.slice(0, 500)}`));
				return;
			}
			// Prefer the last-message file (exact final message). Codex streams agentic
			// chrome to stdout that can contain decoy JSON, so stdout is only a fallback.
			resolve(lastMessage || stdout);
		});
	});
}

/**
 * Pull a JSON object out of a model reply: exact parse, then fenced block, then the
 * widest brace span. Mirrors scope-agent's cli_json.extract_json.
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

		// Case I analog: no API key exists on the codex path (stored login), so a
		// "bad key" is simulated at the transport layer. The adapter cannot tell the
		// difference — both are just !response.ok.
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

		// The adapter JSON.parse()s choices[0].message.content, so the reply must be a
		// bare JSON object. Codex has no response_format flag, so the instruction rides
		// in the prompt (the schema_prompt pattern).
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
			const raw = await runCodex(prompt);
			const parsed = extractJson(raw);
			const elapsedMs = Date.now() - startedAt;

			if (parsed === undefined) {
				// Unparseable reply: answer 502 so the adapter degrades honestly rather
				// than the shim inventing a verdict the model never gave.
				log({ at: new Date().toISOString(), elapsedMs, error: "unparseable", raw: raw.slice(0, 1000) });
				res
					.writeHead(502, { "Content-Type": "application/json" })
					.end(JSON.stringify({ error: { message: "codex reply was not JSON" } }));
				return;
			}

			log({
				at: new Date().toISOString(),
				elapsedMs,
				model: CODEX_MODEL || "codex-default",
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
					id: "codex-shim",
					object: "chat.completion",
					model: CODEX_MODEL || "codex-default",
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

server.listen(PORT, () => {
	process.stdout.write(
		`codex-judge-shim listening on http://127.0.0.1:${PORT} (model=${CODEX_MODEL || "codex-default"}, failMode=${FAIL_MODE || "none"})\n`,
	);
});
