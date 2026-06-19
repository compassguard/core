import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { debug, getLogFile } from "@back/guardrail/debugLogger";

// ─── Test setup ──

const TEST_TMP = join(process.cwd(), "logs-test-debug");

function mockCwd(tmp: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(tmp);
}

function setupEnv(envVal: string | undefined): void {
  if (envVal === undefined) {
    delete process.env["COMPASS_DEBUG"];
  } else {
    process.env["COMPASS_DEBUG"] = envVal;
  }
}

function resetEnv(): void {
  delete process.env["COMPASS_DEBUG"];
}

function ensureTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true });
  mkdirSync(TEST_TMP, { recursive: true });
}

function cleanupTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true });
}

function readLog(): string {
  const logFile = getLogFile();
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf-8");
}

// ─── Tests ──

describe("debugLogger", () => {
  beforeEach(() => {
    ensureTmp();
    mockCwd(TEST_TMP);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEnv();
    cleanupTmp();
  });

  it("1. COMPASS_DEBUG unset → no file created", () => {
    setupEnv(undefined);
    debug("proxy", "dispatch", "Routing tool call");
    expect(existsSync(getLogFile())).toBe(false);
  });

  it("2. COMPASS_DEBUG=true → writes to file", () => {
    setupEnv("true");
    debug("proxy", "dispatch", "Routing tool call");
    const log = readLog();
    expect(log).toContain("[proxy:dispatch]");
  });

  it("3. Module filtering works (single module)", () => {
    setupEnv("policy");
    debug("proxy", "dispatch", "Should not appear");
    const log = readLog();
    expect(log).toBe("");

    debug("policy", "evaluate", "Should appear");
    const log2 = readLog();
    expect(log2).toContain("[policy:evaluate]");
  });

  it("4. Module filtering — multiple modules", () => {
    setupEnv("proxy,policy");
    debug("audit", "record", "Should not appear");
    let log = readLog();
    expect(log).toBe("");

    debug("proxy", "dispatch", "Should appear");
    log = readLog();
    expect(log).toContain("[proxy:dispatch]");
  });

  it("5. Redaction of sensitive keys (top-level)", () => {
    setupEnv("*");
    debug("proxy", "fn", "msg", { secret: "s3cr3t", normalKey: "visible" });
    const log = readLog();
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain("s3cr3t");
    expect(log).toContain("visible");
  });

  it("6. Recursive redaction (nested objects)", () => {
    setupEnv("*");
    debug("proxy", "fn", "msg", {
      nested: { key: "val", apiKey: "abc123" },
    });
    const log = readLog();
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain("abc123");
    expect(log).toContain("val");
  });

  it("7. Format correctness (ISO timestamp, [module:fn] prefix)", () => {
    setupEnv("*");
    debug("policy", "evaluate", "Checking policy rules", { rule: "max_usd" });
    const log = readLog();
    expect(log).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[policy:evaluate\] Checking policy rules /,
    );
  });

  it("8. Data omitted when undefined", () => {
    setupEnv("*");
    debug("proxy", "fn", "No data here");
    const log = readLog();
    expect(log).not.toContain("undefined");
    expect(log).toMatch(/No data here\n$/);
  });

  it("9. COMPASS_DEBUG=0 → no output", () => {
    setupEnv("0");
    debug("proxy", "dispatch", "Should not appear");
    expect(existsSync(getLogFile())).toBe(false);
  });

  it("10. Whitespace in module list", () => {
    setupEnv(" proxy , policy ");
    debug("proxy", "dispatch", "Proxy appears");
    let log = readLog();
    expect(log).toContain("[proxy:dispatch]");

    debug("policy", "evaluate", "Policy appears");
    log = readLog();
    expect(log).toContain("[policy:evaluate]");
  });
});
