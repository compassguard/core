import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

import { findDoc } from "../registry";

// Raw markdown for /docs/<slug>, read from the registered file under public/. The slug is
// resolved through the registry allowlist (findDoc), so no user-controlled path ever reaches
// the filesystem — path traversal is impossible. The public/*.md files are force-bundled into
// this function via outputFileTracingIncludes in next.config.mjs; without that they would be
// missing at runtime on Vercel (nft can't trace the dynamic path).
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params;
	const doc = findDoc(slug);

	if (!doc) {
		return NextResponse.json(
			{ error: { code: "NOT_FOUND", message: `No doc named '${slug}'.` } },
			{ status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
		);
	}

	const markdown = readFileSync(join(process.cwd(), "public", doc.file), "utf-8");

	return new NextResponse(markdown, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "public, max-age=300, must-revalidate",
		},
	});
}
