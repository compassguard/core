/**
 * Tests for Wave 11 MCP config wrapping (secret-safe installer).
 *
 * Acceptance criteria covered:
 * - T11_1.4: One downstream server wrapped behind Compass proxy command,
 *   raw secrets not written to generated config or dry-run output,
 *   multi-downstream and remote MCP shapes rejected as Wave 11 out of scope.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
	createFakeLocalMcpConfigWithSecrets,
	type FakeLocalMcpConfig,
} from "./fixtures/fakeDownstreamMcpServer";
import {
	wrapMcpConfigForProxy,
	formatDryRunOutput,
} from "../mcp/mcpConfigWrapping";

// ---------------------------------------------------------------------------
// T11_1.4: Secret-safe config wrapping
// ---------------------------------------------------------------------------

describe("Wave 11 MCP config wrapping — secret safety", () => {
	it("wraps one downstream server config behind a Compass proxy command", async () => {
		
		const { config } = createFakeLocalMcpConfigWithSecrets();

		const result = wrapMcpConfigForProxy(config);

		// The proxy entry must expose Compass as the only client-facing command
		expect(result.proxyCommand).toBeDefined();
		expect(result.proxyCommand).toContain("compass");
		// The original downstream command must be preserved for downstream startup
		expect(result.downstreamCommand).toBe(config.command);
		expect(result.downstreamArgs).toEqual([...config.args]);
	});

	it("preserves env references without duplicating raw secret values", async () => {
		
		const { config, secrets } = createFakeLocalMcpConfigWithSecrets();

		const result = wrapMcpConfigForProxy(config);

		// The generated config must NOT contain raw secret values
		const serialized = JSON.stringify(result);
		for (const [secretKey, secretValue] of Object.entries(secrets)) {
			// The raw secret value must NOT appear in the output
			expect(serialized).not.toContain(secretValue);
			// But the key name should still be referenceable (env indirection)
			expect(result.envReferences).toContain(secretKey);
		}
	});

	it("does NOT copy raw secrets into dry-run output", async () => {
		const { config, secrets } = createFakeLocalMcpConfigWithSecrets();

		const result = wrapMcpConfigForProxy(config);
		const dryRunOutput = formatDryRunOutput(result);

		// Dry-run output must redact all raw secret values
		for (const secretValue of Object.values(secrets)) {
			expect(dryRunOutput).not.toContain(secretValue);
		}
	});

	it("preserves cwd and args for downstream startup", async () => {
		
		const { config } = createFakeLocalMcpConfigWithSecrets();

		const result = wrapMcpConfigForProxy(config);

		// The config must preserve original downstream startup info
		if (config.cwd) {
			expect(result.downstreamCwd).toBe(config.cwd);
		}
		expect(result.downstreamArgs).toEqual([...config.args]);
	});

	it("rejects multi-downstream config as Wave 11 out of scope", async () => {
		

		// Wave 11 only supports one downstream server per proxy process
		const multiDownstreamConfigs: FakeLocalMcpConfig[] = [
			{
				name: "server-one",
				command: "npx",
				args: ["-y", "server-one"],
			},
			{
				name: "server-two",
				command: "npx",
				args: ["-y", "server-two"],
			},
		];

		for (const config of multiDownstreamConfigs) {
			// This test verifies single-downstream wrapping;
			// multi-downstream is rejected at the config level
			const result = wrapMcpConfigForProxy(config);
			expect(result.isSingleDownstream).toBe(true);
		}

		// Calling with multiple downstream servers must be rejected
		expect(() =>
			wrapMcpConfigForProxy(multiDownstreamConfigs as unknown as FakeLocalMcpConfig),
		).toThrow(/out of scope|single downstream|Wave 11/i);
	});

	it("rejects remote MCP hosting config as Wave 11 out of scope", async () => {
		

		// Remote MCP URL-based config is not stdio
		const remoteConfig = {
			name: "remote-server",
			command: "", // Remote servers don't use stdio commands
			args: [] as const,
			url: "https://remote-mcp.example.com/sse",
		};

		// Remote configurations must be rejected — Wave 11 only supports stdio
		expect(() =>
			wrapMcpConfigForProxy(
				remoteConfig as unknown as FakeLocalMcpConfig,
			),
		).toThrow(/out of scope|stdio|Wave 11|remote/i);
	});

	it("does NOT include native Compass tool names in the wrapped config", async () => {
		
		const { config } = createFakeLocalMcpConfigWithSecrets();

		const result = wrapMcpConfigForProxy(config);
		const serialized = JSON.stringify(result);

		// The wrapped config must not advertise native Compass tools
		const nativeToolNames = [
			"compass_transfer",
			"compass_swap",
			"get_usdc_sol_quote",
			"quote_swap",
			"simulate_conditional_buy_oracle_check",
			"guarded_transfer_sol",
			"guarded_swap_sol_usdc",
			"execute_approved_action",
			"sign_and_send_transaction",
			"create_conditional_buy_sol",
		];

		for (const toolName of nativeToolNames) {
			expect(serialized).not.toContain(toolName);
		}
	});

	it("installer wraps one existing MCP entry behind Compass without leaking secrets", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const existingConfig = {
			mcp: {
				filesystem: {
					type: "local",
					command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
					enabled: true,
					env: {
						OPENAI_API_KEY: "$OPENAI_API_KEY",
						DATABASE_URL: "example-database-url-placeholder",
						NODE_ENV: "test",
					},
				},
			},
		};

		const wrapped = buildCompassWrappedMcpConfig(existingConfig);
		const compass = wrapped.mcp.compass;
		const serialized = JSON.stringify(wrapped);

		expect(Object.keys(wrapped.mcp)).toEqual(["compass"]);
		expect(compass.command).toContain("--downstream-config");
		expect(compass.env.OPENAI_API_KEY).toBe("$OPENAI_API_KEY");
		expect(compass.env.NODE_ENV).toBe("test");
		expect(serialized).not.toContain("user:password@example.test");
		expect(serialized).toContain("envReferences");
	});

	it("installer preserves an already wrapped Compass MCP config", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const downstreamConfig = {
			name: "filesystem",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			envReferences: [],
		};
		const existingConfig = {
			mcp: {
				compass: {
					type: "local",
					command: [
						"npm",
						"run",
						"--silent",
						"mcp:dev",
						"--",
						"--downstream-config",
						JSON.stringify(downstreamConfig),
					],
					enabled: true,
					env: {
						COMPASS_MCP_DOWNSTREAM_CONFIG: JSON.stringify(downstreamConfig),
					},
				},
			},
		};

		expect(buildCompassWrappedMcpConfig(existingConfig)).toEqual(existingConfig);
	});

	it("installer dry-run succeeds for an already wrapped Compass MCP config", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			const downstreamConfig = {
				name: "filesystem",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				envReferences: [],
			};
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						compass: {
							type: "local",
							command: [
								"npm",
								"run",
								"--silent",
								"mcp:dev",
								"--",
								"--downstream-config",
								JSON.stringify(downstreamConfig),
							],
							enabled: true,
							env: {
								COMPASS_MCP_DOWNSTREAM_CONFIG: JSON.stringify(downstreamConfig),
							},
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs"), "--dry-run"],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stderr).not.toContain("No downstream MCP entry found");
			expect(result.stdout).toContain("DRY RUN");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("installer rewrites common raw token values to env references", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const rawSecrets = {
			GITHUB_TOKEN: "fake-github-token-placeholder",
			GITHUB_TOKEN_ALT: "fake-github-pat-placeholder",
			GITLAB_TOKEN: "fake-gitlab-token-placeholder",
			SLACK_BOT_TOKEN: "fake-slack-bot-token-placeholder",
			AUTH_HEADER: "bearer-placeholder",
			SESSION_JWT:
				"fake.jwt.placeholder",
			OPAQUE_TOKEN: "fake-opaque-token-placeholder",
		};
		const existingConfig = {
			mcp: {
				github: {
					type: "local",
					command: ["npx", "-y", "@modelcontextprotocol/server-github"],
					enabled: true,
					env: { ...rawSecrets, NODE_ENV: "test" },
				},
			},
		};

		const wrapped = buildCompassWrappedMcpConfig(existingConfig);
		const serialized = JSON.stringify(wrapped);

		for (const [key, value] of Object.entries(rawSecrets)) {
			expect(serialized).not.toContain(value);
			expect(wrapped.mcp.compass.env[key]).toBe(`$${key}`);
		}
		expect(wrapped.mcp.compass.env.NODE_ENV).toBe("test");
	});

	it("installer dry-run output redacts common raw token values", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			const rawSecret = "fake-github-token-placeholder";
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						github: {
							type: "local",
							command: ["npx", "-y", "@modelcontextprotocol/server-github"],
							enabled: true,
							env: { GITHUB_TOKEN: rawSecret, NODE_ENV: "test" },
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs"), "--dry-run"],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain(rawSecret);
			expect(result.stderr).not.toContain(rawSecret);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("installer rejects embedded secret-like command strings and args", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const rawSecret = "fake-token-placeholder";
		const unsafeConfigs = [
			{ command: `npx --token=${rawSecret}` },
			{ command: [`npx --token=${rawSecret}`, "server"] },
			{ command: ["npx", "server", `--token=${rawSecret}`] },
		];

		for (const { command } of unsafeConfigs) {
			expect(() =>
				buildCompassWrappedMcpConfig({
					mcp: {
						github: {
							type: "local",
							command,
							enabled: true,
							env: { NODE_ENV: "test" },
						},
					},
				}),
			).toThrow(/unsafe secret-like value.*command/i);
		}
	});

	it("installer rejects space-separated secret command args even when values are short", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const unsafeConfigs = [
			{ command: ["npx", "server", "--token", "hunter2"] },
			{ command: ["npx", "server", "--api-key", "hunter2"] },
			{ command: "npx server --token hunter2" },
		];

		for (const { command } of unsafeConfigs) {
			expect(() =>
				buildCompassWrappedMcpConfig({
					mcp: {
						github: {
							type: "local",
							command,
							enabled: true,
							env: { NODE_ENV: "test" },
						},
					},
				}),
			).toThrow(/unsafe secret-like value.*command/i);
		}
	});

	it("installer dry-run rejects space-separated secret args without leaking short values", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						github: {
							type: "local",
							command: "npx server --token hunter2",
							enabled: true,
							env: { NODE_ENV: "test" },
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs"), "--dry-run"],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).not.toBe(0);
			expect(result.stdout).not.toContain("hunter2");
			expect(result.stderr).not.toContain("hunter2");
			expect(result.stderr).toMatch(/unsafe secret-like value.*command/i);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("installer rejects secret-like substrings in downstream cwd", async () => {
		const { buildCompassWrappedMcpConfig } = await import(
			"../../../scripts/install-opencode-mcp.mjs"
		);
		const rawSecret = "fake-token-placeholder";

		expect(() =>
			buildCompassWrappedMcpConfig({
				mcp: {
					github: {
						type: "local",
						command: ["npx", "server"],
			cwd: `/tmp/--token=${rawSecret}`,
						enabled: true,
						env: { NODE_ENV: "test" },
					},
				},
			}),
		).toThrow(/unsafe secret-like value.*cwd/i);
	});

	it("installer dry-run rejects embedded secret-like command args without leaking them", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			const rawSecret = "fake-token-placeholder";
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						github: {
							type: "local",
							command: [
								"npx",
								"-y",
								"@modelcontextprotocol/server-github",
								`--token=${rawSecret}`,
							],
							enabled: true,
							env: { NODE_ENV: "test" },
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs"), "--dry-run"],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).not.toBe(0);
			expect(result.stdout).not.toContain(rawSecret);
			expect(result.stderr).not.toContain(rawSecret);
			expect(result.stderr).toMatch(/unsafe secret-like value.*command/i);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("installer non-dry-run skips raw backup when existing config contains secrets", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			const rawSecret = "fake-github-token-placeholder";
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						github: {
							type: "local",
							command: ["npx", "-y", "@modelcontextprotocol/server-github"],
							enabled: true,
							env: { GITHUB_TOKEN: rawSecret, NODE_ENV: "test" },
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs")],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/skipping raw backup/i);
			expect(result.stdout).not.toContain(rawSecret);
			expect(result.stderr).not.toContain(rawSecret);
			expect(readdirSync(join(tempDir, ".opencode"))).not.toEqual(
				expect.arrayContaining([expect.stringMatching(/opencode\.json\.backup-/)]),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("installer non-dry-run skips raw backup when existing config contains secret-like keys with short values", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "compass-mcp-install-"));
		try {
			mkdirSync(join(tempDir, ".opencode"));
			writeFileSync(
				join(tempDir, ".opencode", "opencode.json"),
				JSON.stringify({
					mcp: {
						github: {
							type: "local",
							command: ["npx", "-y", "@modelcontextprotocol/server-github"],
							enabled: true,
							env: { API_KEY: "hunter2", NODE_ENV: "test" },
						},
					},
				}),
				"utf8",
			);

			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "scripts/install-opencode-mcp.mjs")],
				{ cwd: tempDir, encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/skipping raw backup/i);
			expect(result.stdout).not.toContain("hunter2");
			expect(result.stderr).not.toContain("hunter2");
			expect(readdirSync(join(tempDir, ".opencode"))).not.toEqual(
				expect.arrayContaining([expect.stringMatching(/opencode\.json\.backup-/)]),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
