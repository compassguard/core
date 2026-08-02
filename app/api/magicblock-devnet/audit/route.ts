export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
	return (await import("./routePost")).POST(request);
}

export async function GET(request: Request): Promise<Response> {
	return (await import("./routeGet")).GET(request);
}
