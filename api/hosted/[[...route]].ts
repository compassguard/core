import type { IncomingMessage, ServerResponse } from "node:http";

import {
	createDefaultHostedAppDependencies,
	createHostedApp,
} from "@hosted/app";

const app = createHostedApp(createDefaultHostedAppDependencies());
const HOSTED_PREFIX = "/api/hosted";

export default async function handler(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readRequestBody(request);
	const url = new URL(
		request.url ?? "/",
		`http://${request.headers.host ?? "127.0.0.1"}`,
	);

	url.pathname = stripHostedPrefix(url.pathname);

	const honoResponse = await app.fetch(
		new Request(url, {
			method: request.method,
			headers: request.headers as HeadersInit,
			body: shouldSendBody(request.method) ? body : undefined,
			duplex: "half",
		} as RequestInit),
	);

	response.statusCode = honoResponse.status;
	honoResponse.headers.forEach((value, key) => {
		response.setHeader(key, value);
	});
	response.end(Buffer.from(await honoResponse.arrayBuffer()));
}

function stripHostedPrefix(pathname: string): string {
	if (pathname === HOSTED_PREFIX) {
		return "/";
	}

	return pathname.startsWith(`${HOSTED_PREFIX}/`)
		? pathname.slice(HOSTED_PREFIX.length)
		: pathname;
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function shouldSendBody(method?: string): boolean {
	return method !== "GET" && method !== "HEAD";
}
