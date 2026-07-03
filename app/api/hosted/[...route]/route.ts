import {
	createHostedApp,
} from "@hosted/app";
import type { Hono } from "hono";

const HOSTED_PREFIX = "/api/hosted";

// ponytail: webpack inlines process.env.X at build time. Using Function
// constructor to bypass static analysis so the env var is read at runtime.
const getEnv = new Function("key", "return process.env[key]") as (key: string) => string | undefined;

let cachedApp: Hono | undefined;
function getApp(): Hono {
	if (!cachedApp) {
		cachedApp = createHostedApp({
			auth: { apiKey: getEnv("COMPASS_HOSTED_API_KEY")?.trim() || undefined },
			health: {
				dependencies: {
					auditStore: "ok",
					policy: "ok",
					llm: "ok",
				},
			},
		});
	}
	return cachedApp;
}

export async function GET(request: Request) {
	return handleRequest(request);
}
export async function POST(request: Request) {
	return handleRequest(request);
}
export async function PUT(request: Request) {
	return handleRequest(request);
}
export async function DELETE(request: Request) {
	return handleRequest(request);
}
export async function PATCH(request: Request) {
	return handleRequest(request);
}
export async function OPTIONS(request: Request) {
	return handleRequest(request);
}
export async function HEAD(request: Request) {
	return handleRequest(request);
}

async function handleRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	url.pathname = stripHostedPrefix(url.pathname);

	return getApp().fetch(
		new Request(url, {
			method: request.method,
			headers: request.headers,
			body: shouldSendBody(request.method) ? request.body : undefined,
			duplex: "half",
		} as RequestInit),
	);
}

function stripHostedPrefix(pathname: string): string {
	if (pathname === HOSTED_PREFIX) {
		return "/";
	}

	return pathname.startsWith(`${HOSTED_PREFIX}/`)
		? pathname.slice(HOSTED_PREFIX.length)
		: pathname;
}

function shouldSendBody(method?: string): boolean {
	return method !== "GET" && method !== "HEAD";
}
