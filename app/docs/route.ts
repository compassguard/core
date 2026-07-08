import { NextResponse } from "next/server";

import { DOCS } from "./registry";

// Manifest of available docs, so a frontend can enumerate and link them without hard-coding.
export async function GET() {
	return NextResponse.json(
		{
			docs: DOCS.map((doc) => ({
				slug: doc.slug,
				title: doc.title,
				description: doc.description,
				url: `/docs/${doc.slug}`,
				...(doc.agentUrl ? { agentUrl: doc.agentUrl } : {}),
			})),
		},
		{
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Cache-Control": "public, max-age=300, must-revalidate",
			},
		},
	);
}
