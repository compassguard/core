# Technical Design: Debug Logging Utility

> **Change**: `debug-logging-utility`
> **Status**: Design phase
> **Date**: 2026-06-16

---

## 1. Architecture

### 1.1 Module Placement

One new file, zero structural changes:

```
back/services/guardrail/
├── debugLogger.ts          # NEW — single-file utility
├── execution/              # existing
├── policy/                 # existing
└── router/                 # existing
```

The debug logger is a **leaf utility** — it depends on nothing in the project (only Node.js stdlib). Other modules import it; it never imports them. No circular dependency risk.

### 1.2 Data Flow

```
Call site                         debugLogger.ts                    Output
──────────                        ──────────────                    ──────
debug('proxy', 'dispatch',        COMPASS_DEBUG                     fs.appendFileSync(
  'Routing tool', { tool })         env var check                      "logs/compass-debug.log",
         │                              │                              `[2026-06-16T12:00:00.000Z]
         │                              ▼                              [proxy:dispatch]
         │                      Module in enabledSet?                     Routing tool
         │                           │  │                                {tool: "transfer_sol"}\n`)
         │                    (no)  /    \  (yes)                        ↓
         │                    return     │                           FILE only
         │                              ▼                           (no stdout/stderr noise)
         │                      Redact data arg
         │                      via redactRecord()
         │                              │
         └──────────────────────────────┘
```

### 1.3 Why a Leaf Utility

- **Zero dependencies** — the file is self-contained, no imports from the rest of the project.
- **Called from everywhere** — proxy, policy, execution gateways, domain gateways, connection providers, fixtures. A utility at the `guardrail/` level is accessible from any file in `back/services/` without crossing package boundaries.
- **No side effects at import time** — the env var is read lazily at each call, not at module load. Importing `debugLogger.ts` never writes to the log file by itself.

---

## 2. API Surface

### 2.1 Exports

```typescript
// debugLogger.ts

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

/**
 * Write a debug message to `logs/compass-debug.log` if `COMPASS_DEBUG` enables the given module.
 *
 * @param module  - Module identifier (used for filtering).
 * @param fn      - Function name (included in output, NOT used for filtering).
 * @param message - Descriptive message string.
 * @param data    - Optional structured data; automatically redacted for sensitive keys.
 *
 * @example
 * debug("proxy", "dispatch", "Routing tool call", { tool: "transfer_sol", riskClass: "SIGNING" });
 * // logs/compass-debug.log: [2026-06-16T12:00:00.000Z] [proxy:dispatch] Routing tool call {tool: "transfer_sol", riskClass: "SIGNING"}
 */
export function debug(
  module: DebugModule,
  fn: string,
  message: string,
  data?: Record<string, unknown>,
): void;
```

### 2.2 Design Rationale

| Decision | Why |
|----------|-----|
| `module` as first param | Maps directly to `COMPASS_DEBUG` filter tokens. Enum-like type prevents typos. |
| `fn` as explicit string | Cheaper and more reliable than stack parsing. No risk of inlining breaking frame detection. |
| `message` as plain string | Human-readable first, easy to grep in log file. |
| `data` as optional `Record` | Structured context for debugging. Always redacted by default. |
| No `data` overload without `fn` | Keeps signature unambiguous. If you have data but no funtion info, pass the empty string. |
| No return value | Void — fire-and-forget. No callers should branch on debug output. |

### 2.3 What We DON'T Export (Intentional)

- No `setDebugModules()` or configure function — env var is the only configuration axis.
- No `isDebugEnabled(module)` — premature abstraction. If needed later, can be added.
- No `DebugLevel` enum — single boolean toggle per the proposal scope.

---

## 3. Implementation

### 3.1 Module Filtering

```typescript
// ─── Env var parsing (evaluated on every call — cheap, no caching) ──

function parseEnabledModules(): Set<string> | true {
  const raw = process.env["COMPASS_DEBUG"];
  if (!raw) return new Set();      // unset or empty → nothing enabled
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0") return new Set();
  if (trimmed === "true" || trimmed === "1" || trimmed === "*") return true;

  return new Set(
    trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isModuleEnabled(module: string): boolean {
  const modules = parseEnabledModules();
  if (modules === true) return true;     // COMPASS_DEBUG=true → all modules
  return modules.has(module.toLowerCase());
}
```

**Edge cases handled:**
- `COMPASS_DEBUG` unset → no output
- `COMPASS_DEBUG=` (empty) → no output
- `COMPASS_DEBUG=0` → no output (explicit disable)
- `COMPASS_DEBUG=true` → all modules enabled
- `COMPASS_DEBUG=*` → all modules enabled (wildcard convenience)
- `COMPASS_DEBUG=proxy,policy` → only those two modules
- `COMPASS_DEBUG=" proxy , POLICY "` → trimmed + lowercased, matches `"proxy"` and `"policy"`
- `COMPASS_DEBUG=true,policy` → `true` wins, all enabled (belt-and-suspenders)

No caching of the parsed set. The env var read + `Set.has()` is < 1µs per call. Caching would add a stale-env hazard during tests.

### 3.2 Log File Output Format

```typescript
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "compass-debug.log");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function writeDebug(
  module: string,
  fn: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[${timestamp}] [${module}:${fn}] ${message}${dataStr}\n`;

  ensureLogDir();
  appendFileSync(LOG_FILE, line, "utf-8");
}
```

**Format rationale:**
- ISO 8601 timestamp — sortable, machine-parseable, includes timezone offset.
- Bracketed `[module:fn]` — easy to grep with `grep '\[proxy:' logs/compass-debug.log`.
- Data as compact JSON — single line per debug call, no pretty-printing. If data has sensitive keys, they are redacted before reaching `writeDebug`.
- **File append** — `appendFileSync` is synchronous but debug calls are infrequent and the payload is tiny (<1KB). No async overhead, no buffering complexity.

### 3.3 Redaction Integration

Rather than duplicating the `redactRecord()` / `SENSITIVE_KEY_PATTERN` from `executionGateway.ts`, the debug logger defines its own lightweight redaction. This keeps the file fully self-contained (zero project imports) and avoids coupling to a specific module.

```typescript
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
```

**Why duplicate instead of import the existing one?**
- `executionGateway.ts`'s `redactRecord` is file-private (not exported).
- Exporting it from `executionGateway.ts` would create a dependency from a leaf utility to a feature module — wrong direction.
- Extracting into a shared `redact.ts` is valid but out of scope for this change (see §5).
- 25 lines of pure-function code duplicated once is acceptable; a future `redact.ts` extraction can consolidate.

### 3.4 Complete Implementation (Skeleton)

```typescript
// debugLogger.ts — no imports from the project, only Node.js stdlib
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

type DebugModule =
  | "proxy" | "policy" | "gateway" | "execution"
  | "interceptor" | "llm" | "signer" | "connection" | "audit";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "compass-debug.log");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

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
  appendFileSync(LOG_FILE, `[${timestamp}] [${module}:${fn}] ${message}${dataStr}\n`, "utf-8");
}

// ─── Filtering ──

function isModuleEnabled(module: string): boolean {
  const raw = process.env["COMPASS_DEBUG"];
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "0") return false;
  if (trimmed === "true" || trimmed === "1" || trimmed === "*") return true;

  return new Set(
    trimmed.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ).has(module.toLowerCase());
}

// ─── Redaction ──

const SENSITIVE_KEY_PATTERN = /* ... */;
function redactRecord(/* ... */): /* ... */ { /* ... */ }
function redactValue(/* ... */): /* ... */ { /* ... */ }
function redactUnknown(/* ... */): /* ... */ { /* ... */ }
function isPlainRecord(/* ... */): /* ... */ { /* ... */ }
```

---

## 4. File Changes

### 4.1 New File

| File | Lines | Description |
|------|-------|-------------|
| `back/services/guardrail/debugLogger.ts` | ~50 | Core utility: `debug()`, filtering, redaction |

### 4.2 Modified Files — Debug Insertion

**Priority 1 — Decision flow (greatest debugging value):**

| File | Change | Est. Δ |
|------|--------|--------|
| `back/services/mcp/proxy/mcpProxyDispatcher.ts` | Add debug calls at: router classification point, policy evaluation entry, forwarding decision, denial path | +6 lines |
| `back/services/guardrail/execution/executionGateway.ts` | Add debug calls in: `classifyToolCall()` classification branches, `createCandidate()` input summary | +4 lines |
| `back/services/guardrail/policy/policyEngine.ts` | Add debug call before/after each rule evaluation iteration | +3 lines |
| `back/services/guardrail/policy/policyEvaluationResult.ts` | Add debug call when decision mapping is applied | +2 lines |
| `back/services/mcp/proxy/mcpProxyPolicyInterceptor.ts` | Add debug calls per risk-class match and interceptor decision | +3 lines |

**Priority 2 — Domain gateways:**

| File | Change | Est. Δ |
|------|--------|--------|
| `back/services/domains/transfer/transferGateway.ts` | Add debug call at entry | +1 line |
| `back/services/domains/swap/swapGateway.ts` | Add debug call at entry | +1 line |
| `back/services/domains/conditional-parking-lot/conditionalGateway.ts` | Add debug call at entry | +1 line |

### 4.3 Modified Files — Console Migration

These replace existing `console.log/error` calls with `debug()`:

| File | Current | Replace With | Line |
|------|---------|--------------|------|
| `back/services/mcp/server/mcpServer.ts` | `console.error(...)` | `debug("gateway", "startServer", ...)` | 216 |
| `back/services/mcp/config/loadRepoEnv.ts` | `console.error(...)` | `debug("connection", "loadEnv", ...)` | 145 |
| `back/services/solana/providers/solanaConnection.ts` | `console.log(...)` | `debug("connection", "createConnection", ...)` | 32 |
| `back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts` | `console.error(...)` | `debug("connection", "handleFailure", ...)` | 272 |

**Note on `mcpServer.test.ts`** line 359: This test asserts that `console.error()` is called when the server fails. It must be updated to set `COMPASS_DEBUG=gateway` and check that stderr receives the expected debug output instead. See §6.

### 4.4 Comprehensive Change Summary

```
 1 file created
10 files modified
~23 lines added total (net)
```

All modifications in §4.2 and §4.3 remain well within the 800-line review budget.

---

## 5. Integration & Migration Strategy

### 5.1 Migration of Existing Console Calls

Each `console.log/error` → `debug()` migration is a drop-in replacement:

```typescript
// Before:
console.error(`Compass MCP stdio server failed to start: ${message}`);

// After:
import { debug } from "../../guardrail/debugLogger";
debug("gateway", "startServer", "Compass MCP stdio server failed to start", { message });
```

The env var `COMPASS_DEBUG=gateway` must be set for this output to appear. This is a behavioral change: previously these messages always printed (via console.error), now they are silent by default.

**Risk:** Existing users or CI that relied on these console.error messages appearing will no longer see them. **Mitigation:** These are startup/debug messages, not critical error signaling. Production error handling should use proper error propagation or the audit trail, not console.error.

### 5.2 Redaction Consolidation (Future)

The `SENSITIVE_KEY_PATTERN` regex and `redactRecord()`/`redactSecretArguments()` functions currently exist in three places:
- `executionGateway.ts` — `redactRecord()` (file-private)
- `mcpProxyAudit.ts` — `redactSecretArguments()` (exported)
- `debugLogger.ts` — `redactRecord()` (NEW, file-private)

A future extraction to a shared `back/services/guardrail/redact.ts` would consolidate all three. This is **out of scope** for the current change to keep the diff minimal, but should be prioritized in the next cycle.

### 5.3 No Config Registry Change

`COMPASS_DEBUG` is read directly from `process.env` — the existing `getEnv()` in `envConfig.ts` supports multi-name fallback but is not needed here since there's a single canonical env var name. If env var naming conventions change later, the single `process.env["COMPASS_DEBUG"]` reference is trivially updated.

---

## 6. Testing Strategy

### 6.1 Unit Tests for `debugLogger.ts`

Tests live at `back/services/__tests__/debugLogger.test.ts`.

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | COMPASS_DEBUG unset → no file created | Unset env var, call `debug("proxy", "fn", "msg")` | `logs/compass-debug.log` does not exist |
| 2 | COMPASS_DEBUG=true → writes to file | Set `COMPASS_DEBUG=true`, call `debug("proxy", "fn", "msg")` | File contains `"[proxy:fn]"` |
| 3 | Module filtering works | Set `COMPASS_DEBUG=policy`, call `debug("proxy", "fn", "msg")` | File is empty or does not contain proxy output |
| 4 | Module filtering — multiple | Set `COMPASS_DEBUG=proxy,policy`, call `debug("audit", "fn", "msg")` | File does not contain audit output; calling `debug("proxy")` writes |
| 5 | Redaction of sensitive keys | Call `debug("proxy", "fn", "msg", { secret: "s3cr3t" })` | File contains `"[REDACTED]"`, not `"s3cr3t"` |
| 6 | Recursive redaction | Call `debug("proxy", "fn", "msg", { nested: { key: "val", apiKey: "abc" } })` | Nested `apiKey` is `"[REDACTED]"`, `key` is `"val"` |
| 7 | Format correctness | Set `COMPASS_DEBUG=*`, read file | Line matches `/^\[\d{4}-\d{2}-\d{2}T.*Z\] \[policy:evaluate\] .+$/` |
| 8 | DATA omitted when undefined | Call `debug("proxy", "fn", "msg")` | No `JSON.stringify(undefined)` in file |
| 9 | COMPASS_DEBUG=0 → no output | Set `COMPASS_DEBUG=0` | File is empty or absent |
| 10 | Whitespace in module list | Set `COMPASS_DEBUG=" proxy , policy "` | Both `proxy` and `policy` write to file |

**Test isolation:** Each test should use a temp directory for `logs/` and clean up after itself. Override `LOG_DIR` / `LOG_FILE` via a test-only helper or mock `process.cwd()`.

```typescript
import { debug } from "../guardrail/debugLogger";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_LOG_DIR = join(process.cwd(), "logs-test-debug");
const TEST_LOG_FILE = join(TEST_LOG_DIR, "compass-debug.log");

function setupTestEnv(): void {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
  // Override LOG_DIR/LOG_FILE — see §6.1 note below
}

function readLog(): string {
  if (!existsSync(TEST_LOG_FILE)) return "";
  return readFileSync(TEST_LOG_FILE, "utf-8");
}
```

**Note:** Since `LOG_DIR` and `LOG_FILE` are module-level constants, tests need either:
- (a) A test-only export to override them, or
- (b) Mock `process.cwd()` to point to a temp dir, or
- (c) Extract `getLogPath()` as a function that reads `process.cwd()` at call time (preferred — keeps production code clean and tests simple).

### 6.2 Integration — Console Migration Test Update

`back/services/__tests__/mcpServer.test.ts` line 359 currently asserts:

```typescript
"console.error(error instanceof Error ? ...)"
```

This must be updated to:

```typescript
process.env["COMPASS_DEBUG"] = "gateway";
// ... trigger server failure ...
// assert that logs/compass-debug.log contains the expected debug line
```

This is a single test update in the same change set.

### 6.3 Console Migration — `fakeDownstreamMcpServer.ts`

The test fixture at `fakeDownstreamMcpServer.ts` uses `console.error` for internal error logging. Migrating it to `debug("connection", ...)` is correct but has a subtlety: test fixtures are imported by tests, and the debug call may fire during test setup when `COMPASS_DEBUG` is not set. This is safe (no-op when unset), but the original behavior produced unconditional stderr output — now it's silent. No test should depend on fixture stderr noise.

---

## 7. Config: COMPASS_DEBUG Parsing

### 7.1 Grammar

```
COMPASS_DEBUG = "" | "0" | "true" | "1" | "*" | module-list
module-list   = module ("," module)*
module        = "proxy" | "policy" | "gateway" | "execution"
              | "interceptor" | "llm" | "signer" | "connection" | "audit"
```

### 7.2 Resolution Table

| Value | Behavior |
|-------|----------|
| *(unset)* | No debug output |
| `""` (empty) | No debug output |
| `"0"` | No debug output (explicit disable) |
| `"true"` | All modules enabled |
| `"1"` | All modules enabled |
| `"*"` | All modules enabled |
| `"proxy"` | Only proxy module |
| `"proxy,policy"` | Proxy and policy modules |
| `"proxy,policy,execution,gateway,interceptor,llm,signer,connection,audit"` | All modules (explicit) |
| `" Proxy , POLICY "` | Case-insensitive, trimmed |

### 7.3 Error Handling

Unknown module names are silently ignored. `COMPASS_DEBUG=proxy,nonexistent` enables only `proxy`. This is intentional — a mistyped module name should not crash the server.

---

## 8. Key Design Decisions Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Leaf utility, zero project imports** | Avoids circular deps; stays always importable from anywhere |
| 2 | **Env var read at call time (no cache)** | Easy test isolation; no stale-env bugs; negligible perf cost |
| 3 | **Explicit `fn` parameter** | More reliable and cheaper than `Error().stack` parsing |
| 4 | **Duplicate redact logic (25 lines)** | Keeps file self-contained; extraction to shared `redact.ts` is future work |
| 5 | **No `isDebugEnabled()` export** | YAGNI — single `debug()` function covers the pattern |
| 6 | **`void` return** | Callers never branch on debug output; fire-and-forget |
| 7 | **Silent by default** | Existing `console.error` produced unconditional output; now gated behind `COMPASS_DEBUG`. Matches the "debug" semantics — opt-in. |
| 8 | **File output (`logs/compass-debug.log`)** | No stdout/stderr noise; MCP protocol stays clean. Log file is greppable, persists across runs, easy to tail. |
| 9 | **`appendFileSync`** | Debug calls are infrequent and tiny. Synchronous append avoids async complexity with no measurable perf cost. |
| 10 | **No log rotation** | YAGNI — file is opt-in debug output, not production telemetry. Manual `rm logs/compass-debug.log` is sufficient. Add rotation when needed. |
| 11 | **No envConfig.ts integration** | Single canonical env var name; `getEnv()` multi-name fallback adds complexity with no benefit here |

---

## 9. Next Recommended Phase

**Proceed to `sdd-tasks`** — the design is well-bounded (one file, ~50 loc, ~23 lines of insertion across 10 files). Key items for the task breakdown:

1. Create `debugLogger.ts` (the core)
2. Add debug calls to 5 high-priority files (§4.2)
3. Migrate 4 existing console calls (§4.3)
4. Write unit tests (§6.1)
5. Update `mcpServer.test.ts` integration test (§6.2)
6. Verify: `COMPASS_DEBUG=true` captures all output, `COMPASS_DEBUG=policy` filters correctly, sensitive data is redacted, stdout is untouched

**Recommendation:** Flag the redact.ts extraction as a follow-up improvement but keep it separate from this change to stay under the 800-line review budget.