export async function GET() {
	return Response.json(
		{
			service: "Compass Guard API",
			status: "ok",
			message: "Compass Guard API is running.",
			documentation: "https://docs.compassguard.xyz",
			health: "/health",
			apiVersion: "v1",
		},
		{ status: 200, headers: { "Cache-Control": "public, max-age=300" } },
	);
}
