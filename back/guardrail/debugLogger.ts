/**
 * Toggleable debug logging utility for Compass MCP Guard.
 *
 * Writes to `logs/compass-debug.log` when `COMPASS_DEBUG` env var enables
 * the relevant module. Zero project imports — only Node.js stdlib.
 *
 * @module debugLogger
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──

/** Valid module identifiers for debug filtering. */
export type DebugModule =
  | "proxy"
  | "policy"
  | "gateway"
  | "execution"
  | "interceptor"
  | "llm"
  | "signer"
  | "connection"
  | "audit";

// ─── Path resolution (functions, not module consts — enables test isolation via process.cwd() mock) ──

/** Get the log directory path (resolved at call time). */
export function getLogDir(): string {
  return join(process.cwd(), "logs");
}

/** Get the full log file path (resolved at call time). */
export function getLogFile(): string {
  return join(getLogDir(), "compass-debug.log");
}

// ─── Core debug function ──

/**
 * Write a debug message to `logs/compass-debug.log` if `COMPASS_DEBUG`
 * enables the given module.
 *
 * @param module  - Module identifier (used for filtering).
 * @param fn      - Function name (included in output, NOT used for filtering).
 * @param message - Descriptive message string.
 * @param data    - Optional structured data; automatically redacted for sensitive keys.
 */
export function debug(
  module: DebugModule,
  fn: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!isModuleEnabled(module)) return;

  const safeData = data ? redactRecord(data) : undefined;
  const timestamp = new Date().toISOString();
  const dataStr = safeData ? ` ${JSON.stringify(safeData)}` : "";

  ensureLogDir();
  appendFileSync(
    getLogFile(),
    `[${timestamp}] [${module}:${fn}] ${message}${dataStr}\n`,
    "utf-8",
  );
}

// ─── Env var filtering ──

function isModuleEnabled(module: string): boolean {
  const raw = process.env["COMPASS_DEBUG"];
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "0") return false;

  const tokens = trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // "true", "1", or "*" anywhere in the list enables all modules
  if (tokens.some((t) => t === "true" || t === "1" || t === "*")) return true;

  return tokens.includes(module.toLowerCase());
}

// ─── Directory management ──

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─── Sensitive key redaction (self-contained, mirrors executionGateway) ──

const SENSITIVE_KEY_PATTERN =
  /(private.*key|secret|password|mnemonic|seed|api.*key|authorization|cookie|jwt|session.*token|auth.*token|access.*token|refresh.*token|prompt|raw.*prompt|raw.*user.*prompt)/i;

function redactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, redactValue(key, value)]),
  );
}

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (isPlainRecord(value)) return redactRecord(value);
  return value;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (isPlainRecord(value)) return redactRecord(value);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}