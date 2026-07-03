import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["back/services/mcp/server/mcpServer.ts"],
	outDir: "dist",
	format: "esm",
	platform: "node",
	target: "node18",
	bundle: true,
	splitting: false,
	clean: true,
	banner: {
		js: "#!/usr/bin/env node",
	},
	outExtension: () => ({ js: ".js" }),
});
