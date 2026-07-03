#!/usr/bin/env node
// Downstream MCP server for testing the Compass proxy.
// Simulates crypto tools that trigger different guardrail paths:
//   - read_only: balance, list, price (pass prefilter directly)
//   - transfer: send (router → LLM Decision)
//   - swap: swap (router → LLM Decision)
//   - ambiguous: createOrder (router → unknown → approval)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Fake balances
const wallets = {
  SOL: 12.5,
  USDC: 1500.0,
  BTC: 0.05,
  ETH: 1.2,
};

const downstream = new Server(
  { name: "compass-test-downstream", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

downstream.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── READ-ONLY ──────────────────────────────────────────────
    {
      name: "getPortfolioBalance",
      description: "Get the current balance of all assets in the portfolio",
      inputSchema: {
        type: "object",
        properties: {
          portfolioId: { type: "string", description: "Portfolio UUID" },
        },
      },
    },
    {
      name: "listAssets",
      description: "List all held assets with amounts and values",
      inputSchema: {
        type: "object",
        properties: {
          currency: { type: "string", description: "Filter by currency" },
        },
      },
    },
    {
      name: "getTokenPrice",
      description: "Get the current price of a token in USD",
      inputSchema: {
        type: "object",
        properties: {
          token: { type: "string", description: "Token symbol (e.g. BTC, ETH)" },
        },
        required: ["token"],
      },
    },

    // ── TRANSFER ───────────────────────────────────────────────
    {
      name: "sendToken",
      description: "Send tokens to a wallet address",
      inputSchema: {
        type: "object",
        properties: {
          token: { type: "string", description: "Token to send" },
          amount: { type: "number", description: "Amount to send" },
          toAddress: { type: "string", description: "Recipient wallet address" },
        },
        required: ["token", "amount", "toAddress"],
      },
    },

    // ── SWAP ───────────────────────────────────────────────────
    {
      name: "swapToken",
      description: "Exchange one token for another at market rate",
      inputSchema: {
        type: "object",
        properties: {
          fromToken: { type: "string", description: "Token to sell" },
          toToken: { type: "string", description: "Token to buy" },
          amount: { type: "number", description: "Amount to swap" },
          slippage: { type: "number", description: "Max slippage in bps" },
        },
        required: ["fromToken", "toToken", "amount"],
      },
    },

    // ── AMBIGUOUS ──────────────────────────────────────────────
    {
      name: "createOrder",
      description: "Create a limit or market order",
      inputSchema: {
        type: "object",
        properties: {
          pair: { type: "string", description: "Trading pair (e.g. BTC-USD)" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
          size: { type: "number", description: "Order size" },
          price: { type: "number", description: "Limit price (omit for market)" },
        },
        required: ["pair", "side", "size"],
      },
    },
  ],
}));

downstream.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "getPortfolioBalance") {
    const total = Object.values(wallets).reduce((s, v) => s + v, 0);
    return {
      content: [{ type: "text", text: JSON.stringify({ wallets, totalUsd: total }) }],
    };
  }

  if (name === "listAssets") {
    const filtered = args?.currency
      ? Object.entries(wallets).filter(([k]) => k === args.currency)
      : Object.entries(wallets);
    const assets = filtered.map(([symbol, balance]) => ({ symbol, balance }));
    return {
      content: [{ type: "text", text: JSON.stringify({ assets }) }],
    };
  }

  if (name === "getTokenPrice") {
    const prices = { SOL: 180, USDC: 1, BTC: 105000, ETH: 3800 };
    const price = prices[args?.token] ?? null;
    return {
      content: [{ type: "text", text: JSON.stringify({ token: args?.token, priceUsd: price }) }],
    };
  }

  if (name === "sendToken") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          txId: `sim-tx-${Date.now()}`,
          token: args?.token,
          amount: args?.amount,
          toAddress: args?.toAddress,
        }),
      }],
    };
  }

  if (name === "swapToken") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          txId: `sim-swap-${Date.now()}`,
          from: args?.fromToken,
          to: args?.toToken,
          amount: args?.amount,
          estimatedOutput: (args?.amount ?? 0) * 0.997,
        }),
      }],
    };
  }

  if (name === "createOrder") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          orderId: `sim-order-${Date.now()}`,
          pair: args?.pair,
          side: args?.side,
          size: args?.size,
          price: args?.price ?? "market",
        }),
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await downstream.connect(transport);
