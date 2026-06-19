import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readHostedBackendEnvConfig } from "../envConfig";

describe("hybrid migration cleanup", () => {
	it("removes deprecated downstream proxy modules and legacy imports", () => {
		const downstreamClientPath = join(
			process.cwd(),
			"back/services/mcp/proxy/downstreamMcpStdioClient.ts",
		);
		const configWrappingPath = join(
			process.cwd(),
			"back/services/mcp/proxy/mcpConfigWrapping.ts",
		);
		const mcpServerSource = readFileSync(
			join(process.cwd(), "back/services/mcp/server/mcpServer.ts"),
			"utf8",
		);

		expect(existsSync(downstreamClientPath)).toBe(false);
		expect(existsSync(configWrappingPath)).toBe(false);
		expect(mcpServerSource).not.toContain("downstreamMcpStdioClient");
	});

	it("keeps proxy audit as diagnostics only", () => {
		const dispatcherSource = readFileSync(
			join(process.cwd(), "back/services/mcp/proxy/mcpProxyDispatcher.ts"),
			"utf8",
		);

		expect(dispatcherSource).not.toContain("recordProxyAudit");
		expect(dispatcherSource).not.toContain("markProxyAuditFailure");
	});

	it("moves policy and llm imports to hosted copies", () => {
		const hostedDecisionAdapterSource = readFileSync(
			join(process.cwd(), "hosted/llm/llmDecisionAdapter.ts"),
			"utf8",
		);
		const hostedRouterAdapterSource = readFileSync(
			join(process.cwd(), "hosted/llm/llmRouterAdapter.ts"),
			"utf8",
		);
		const transferGatewaySource = readFileSync(
			join(process.cwd(), "back/services/domains/transfer/transferGateway.ts"),
			"utf8",
		);

		expect(hostedDecisionAdapterSource).not.toContain("../../intelligence/llm-decision/");
		expect(hostedRouterAdapterSource).not.toContain("../../intelligence/llm-router/llmRouterAdapter");
		expect(hostedRouterAdapterSource).not.toContain("../../intelligence/llm-router/llmRouterContracts");
		expect(transferGatewaySource).not.toContain("../../guardrail/policy/");
	});

	it("enables the hybrid guard by default while allowing explicit opt-out", () => {
		expect(readHostedBackendEnvConfig({}).hybridGuardEnabled).toBe(true);
		expect(
			readHostedBackendEnvConfig({ COMPASS_HYBRID_GUARD_ENABLED: "false" })
				.hybridGuardEnabled,
		).toBe(false);
	});

	it("adds vercel routing for hosted health and v1 endpoints", () => {
		const vercelConfigPath = join(process.cwd(), "vercel.json");
		expect(existsSync(vercelConfigPath)).toBe(true);

		const vercelConfig = JSON.parse(readFileSync(vercelConfigPath, "utf8")) as {
			rewrites?: Array<{ source: string; destination: string }>;
		};

		expect(vercelConfig.rewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "/health",
					destination: "/api/hosted/health",
				}),
				expect.objectContaining({
					source: "/v1/:path*",
					destination: "/api/hosted/v1/:path*",
				}),
			]),
		);
	});
});
