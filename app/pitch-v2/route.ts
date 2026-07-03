import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

export async function GET() {
	const html = readFileSync(join(process.cwd(), "pitch-v2.html"), "utf-8");

	return new NextResponse(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store, must-revalidate",
		},
	});
}
