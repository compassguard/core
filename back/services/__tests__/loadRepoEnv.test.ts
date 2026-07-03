import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	loadRepoEnv,
	parseEnvContents,
	resetLoadRepoEnvFlag,
} from "../mcp/config/loadRepoEnv";
import { getLogFile } from "@back/guardrail/debugLogger";

function readDebugLog(): string {
	const logFile = getLogFile();
	if (!existsSync(logFile)) return "";
	return readFileSync(logFile, "utf-8");
}

function setupDebugEnv(): void {
	process.env["COMPASS_DEBUG"] = "connection";
}

function teardownDebugEnv(): void {
	delete process.env["COMPASS_DEBUG"];
	const logFile = getLogFile();
	const logDir = join(logFile, "..");
	if (existsSync(logDir)) {
		rmSync(logDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// parseEnvContents
// ---------------------------------------------------------------------------

describe("parseEnvContents", () => {
	it("parses simple KEY=value pairs", () => {
		const result = parseEnvContents("FOO=bar\nBAZ=qux");
		expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	it("skips comments and empty lines", () => {
		const result = parseEnvContents("# comment\n\nFOO=bar\n# another comment\nBAZ=qux");
		expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	it("handles double-quoted values", () => {
		const result = parseEnvContents('KEY="hello world"');
		expect(result).toEqual({ KEY: "hello world" });
	});

	it("handles single-quoted values", () => {
		const result = parseEnvContents("KEY='hello world'");
		expect(result).toEqual({ KEY: "hello world" });
	});

	it("strips inline comments from unquoted values", () => {
		const result = parseEnvContents("KEY=value # this is a comment");
		expect(result).toEqual({ KEY: "value" });
	});

	it("does not strip # inside quoted values", () => {
		const result = parseEnvContents('KEY="value#nocomment"');
		expect(result).toEqual({ KEY: "value#nocomment" });
	});

	it("strips export prefix", () => {
		const result = parseEnvContents("export FOO=bar");
		expect(result).toEqual({ FOO: "bar" });
	});

	it("skips lines without =", () => {
		const result = parseEnvContents("JUST_A_WORD\nFOO=bar");
		expect(result).toEqual({ FOO: "bar" });
	});

	it("handles empty values", () => {
		const result = parseEnvContents("EMPTY=");
		expect(result).toEqual({ EMPTY: "" });
	});

	it("handles values with equals signs", () => {
		const result = parseEnvContents("CONNECTION_STRING=host=localhost;port=5432");
		expect(result).toEqual({ CONNECTION_STRING: "host=localhost;port=5432" });
	});

	it("handles URL values", () => {
		const result = parseEnvContents(
			"COMPASS_LLM_BASE_URL=https://api.example.com/v1/responses",
		);
		expect(result).toEqual({
			COMPASS_LLM_BASE_URL: "https://api.example.com/v1/responses",
		});
	});
});

// ---------------------------------------------------------------------------
// loadRepoEnv
// ---------------------------------------------------------------------------

describe("loadRepoEnv", () => {
	const tmpDir = join(process.cwd(), ".tmp-test-env");

	beforeEach(() => {
		resetLoadRepoEnvFlag();
		// Clean up any leftover env vars from other tests
		delete process.env._TEST_ENV_FOO;
		delete process.env._TEST_ENV_BAR;
		delete process.env._TEST_ENV_SECRET;
		delete process.env.COMPASS_LLM_DECISION_ENABLED;
		delete process.env.COMPASS_LLM_BASE_URL;
		delete process.env.COMPASS_LLM_API_KEY;
	});

	afterEach(() => {
		resetLoadRepoEnvFlag();
		delete process.env._TEST_ENV_FOO;
		delete process.env._TEST_ENV_BAR;
		delete process.env._TEST_ENV_SECRET;
		// Clean up tmp dir
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("loads variables from .env into process.env", () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, ".env"), "_TEST_ENV_FOO=hello\n_TEST_ENV_BAR=world");

		const result = loadRepoEnv({ overrideRootDir: tmpDir });

		expect(result.loaded).toBe(true);
		expect(result.keysLoaded).toContain("_TEST_ENV_FOO");
		expect(result.keysLoaded).toContain("_TEST_ENV_BAR");
		expect(process.env._TEST_ENV_FOO).toBe("hello");
		expect(process.env._TEST_ENV_BAR).toBe("world");
	});

	it("does not override existing process.env values", () => {
		process.env._TEST_ENV_FOO = "already-set";
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, ".env"), "_TEST_ENV_FOO=from-file");

		const result = loadRepoEnv({ overrideRootDir: tmpDir });

		expect(result.keysLoaded).not.toContain("_TEST_ENV_FOO");
		expect(process.env._TEST_ENV_FOO).toBe("already-set");
	});

	it("returns empty keysLoaded when .env does not exist", () => {
		const result = loadRepoEnv({ overrideRootDir: tmpDir });
		expect(result.loaded).toBe(true);
		expect(result.keysLoaded).toEqual([]);
	});

	it("is idempotent - second call returns empty keysLoaded", () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, ".env"), "_TEST_ENV_FOO=first");

		const first = loadRepoEnv({ overrideRootDir: tmpDir });
		expect(first.keysLoaded).toContain("_TEST_ENV_FOO");

		const second = loadRepoEnv({ overrideRootDir: tmpDir });
		expect(second.keysLoaded).toEqual([]);
	});

	it("masks secret keys in logged output", () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, ".env"), "_TEST_ENV_SECRET=sk-super-secret-value\n_TEST_ENV_FOO=visible");

		setupDebugEnv();
		loadRepoEnv({ overrideRootDir: tmpDir });

		const log = readDebugLog();
		expect(log).toContain("_TEST_ENV_SECRET=***");
		expect(log).toContain("_TEST_ENV_FOO");
		expect(log).not.toContain("sk-super-secret-value");

		teardownDebugEnv();
	});

	it("loads COMPASS_LLM_* variables from .env", () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(
			join(tmpDir, ".env"),
			"COMPASS_LLM_DECISION_ENABLED=true\nCOMPASS_LLM_BASE_URL=https://api.test/v1/responses\nCOMPASS_LLM_API_KEY=sk-test-key",
		);

		const result = loadRepoEnv({ overrideRootDir: tmpDir });

		expect(result.keysLoaded).toContain("COMPASS_LLM_DECISION_ENABLED");
		expect(result.keysLoaded).toContain("COMPASS_LLM_BASE_URL");
		expect(result.keysLoaded).toContain("COMPASS_LLM_API_KEY");
		expect(process.env.COMPASS_LLM_DECISION_ENABLED).toBe("true");
		expect(process.env.COMPASS_LLM_BASE_URL).toBe("https://api.test/v1/responses");
		expect(process.env.COMPASS_LLM_API_KEY).toBe("sk-test-key");
	});

	it("does not override COMPASS_LLM_* vars already set in process.env", () => {
		process.env.COMPASS_LLM_DECISION_ENABLED = "false";
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(
			join(tmpDir, ".env"),
			"COMPASS_LLM_DECISION_ENABLED=true",
		);

		loadRepoEnv({ overrideRootDir: tmpDir });

		expect(process.env.COMPASS_LLM_DECISION_ENABLED).toBe("false");
	});
});
