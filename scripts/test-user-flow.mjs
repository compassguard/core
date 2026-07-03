#!/usr/bin/env node
/**
 * User-perspective test: connects to Compass MCP server as a real agent would.
 * Tests every guardrail path end-to-end.
 *
 * Usage:
 *   node scripts/test-user-flow.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const DOWNSTREAM = join(process.cwd(), "scripts/test-downstream-mcp.mjs");
const MCP_SERVER = join(process.cwd(), "back/services/mcp/server/mcpServer.ts");

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36m→\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    if (detail) console.log(`    ${detail}`);
    failed++;
  }
}

async function createClient() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: [
      "tsx", MCP_SERVER, "--",
      "--downstream-name", "compass-test",
      "--downstream-command", "node",
      "--downstream-args-json", JSON.stringify([DOWNSTREAM]),
    ],
    env: {
      ...process.env,
      COMPASS_HYBRID_GUARD_ENABLED: "true",
      COMPASS_HOSTED_API_URL: "http://localhost:3001",
      COMPASS_HOSTED_API_KEY: "local-test-key",
      COMPASS_HOSTED_TIMEOUT_MS: "5000",
      COMPASS_INSTALLATION_ID: "user-flow-test",
      COMPASS_LLM_DECISION_ENABLED: "true",
      COMPASS_LLM_PROVIDER: "nan",
      COMPASS_LLM_MODEL: "gemma4",
      COMPASS_LLM_API_KEY: process.env.COMPASS_LLM_API_KEY ?? "",
      COMPASS_LLM_BASE_URL: process.env.COMPASS_LLM_BASE_URL ?? "",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "user-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function main() {
  console.log("\n🧪 Compass MCP Guard — User Flow Test\n");

  // ── 1. Connection & tool discovery ────────────────────────────────
  console.log(`${INFO} Connecting to MCP server...`);
  const { client, transport } = await createClient();

  console.log(`${INFO} Listing tools from downstream...`);
  const { tools } = await client.listTools();

  assert(tools.length > 0, `Discovered ${tools.length} tools from downstream`);

  const toolNames = tools.map(t => t.name);
  assert(toolNames.includes("getPortfolioBalance"), "getPortfolioBalance present");
  assert(toolNames.includes("sendToken"), "sendToken present");
  assert(toolNames.includes("swapToken"), "swapToken present");
  assert(toolNames.includes("createOrder"), "createOrder present");

  // ── 2. Read-only tools → allow ───────────────────────────────────
  console.log(`\n${INFO} Testing read-only tools (should be ALLOWED)...`);

  const balance = await client.callTool({
    name: "getPortfolioBalance",
    arguments: { portfolioId: "test-portfolio" },
  });
  assert(balance.isError !== true, "getPortfolioBalance → allowed (not error)");
  assert(
    JSON.stringify(balance).includes("wallets"),
    "getPortfolioBalance → returns real data from downstream",
  );

  const price = await client.callTool({
    name: "getTokenPrice",
    arguments: { token: "BTC" },
  });
  assert(price.isError !== true, "getTokenPrice → allowed");

  const assets = await client.callTool({
    name: "listAssets",
    arguments: {},
  });
  assert(assets.isError !== true, "listAssets → allowed");

  // ── 3. Transfer-like tool → routed to hosted ────────────────────────
  console.log(`\n${INFO} Testing transfer-like tool (should route to hosted)...`);

  const transfer = await client.callTool({
    name: "sendToken",
    arguments: { token: "SOL", amount: 0.5, toAddress: "Alice" },
  });
  const transferBody = JSON.stringify(transfer);
  assert(
    transferBody.includes("confirm") || transferBody.includes("allow") ||
    transferBody.includes("require_approval") || transferBody.includes("deny"),
    "sendToken → routed to hosted (decision made)",
    transferBody.slice(0, 300),
  );

  // ── 4. Swap tool → routed to hosted ───────────────────────────────
  console.log(`\n${INFO} Testing swap tool (should route to hosted)...`);

  const swap = await client.callTool({
    name: "swapToken",
    arguments: { fromToken: "SOL", toToken: "USDC", amount: 1.0, slippage: 50 },
  });
  const swapBody = JSON.stringify(swap);
  assert(
    swapBody.includes("confirm") || swapBody.includes("allow") ||
    swapBody.includes("require_approval") || swapBody.includes("deny"),
    "swapToken → routed to hosted (decision made)",
    swapBody.slice(0, 300),
  );

  // ── 5. Unknown/ambiguous tool → routed to hosted ──────────────────
  console.log(`\n${INFO} Testing ambiguous tool (should route to hosted)...`);

  const order = await client.callTool({
    name: "createOrder",
    arguments: { pair: "BTC-USD", side: "BUY", size: 0.1 },
  });
  const orderBody = JSON.stringify(order);
  assert(
    orderBody.includes("confirm") || orderBody.includes("allow") ||
    orderBody.includes("require_approval") || orderBody.includes("deny"),
    "createOrder → routed to hosted (decision made)",
    orderBody.slice(0, 300),
  );

  // ── 6. Audit trail check ─────────────────────────────────────────
  console.log(`\n${INFO} Checking hosted audit trail...`);
  // Give a moment for audit writes to complete
  await new Promise(r => setTimeout(r, 500));

  // Query audit by sessionId (the MCP server generates one)
  const auditResp = await fetch("http://localhost:3001/v1/audits?userId=user-flow-test&limit=10", {
    headers: { "Authorization": "Bearer local-test-key" },
  });
  if (auditResp.ok) {
    const audit = await auditResp.json();
    assert(
      audit.audits && audit.audits.length > 0,
      `Audit has ${audit.audits?.length ?? 0} entries (correlation tracked)`,
    );
  } else {
    assert(false, "Audit endpoint reachable", `Status: ${auditResp.status}`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  await client.close();
  await transport.close();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
