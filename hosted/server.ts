import { createDefaultHostedAppDependencies, createHostedApp } from "./app";
import type { BunRuntime } from "./serverContracts";

declare const Bun: BunRuntime;

const DEFAULT_HOSTED_PORT = 3001;

const app = createHostedApp(createDefaultHostedAppDependencies());
const port = resolvePort(process.env.COMPASS_HOSTED_PORT ?? process.env.PORT);

Bun.serve({
	port,
	fetch: app.fetch,
});

console.info(`Compass hosted guard listening on http://localhost:${port}`);

function resolvePort(rawPort: string | undefined): number {
	if (!rawPort) return DEFAULT_HOSTED_PORT;

	const port = Number.parseInt(rawPort, 10);
	return Number.isFinite(port) && port > 0 ? port : DEFAULT_HOSTED_PORT;
}
