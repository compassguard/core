import { NextResponse } from "next/server";

export async function GET() {
	return new NextResponse(`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Compass Demo</title>
	<meta name="description" content="Compass demo video" />
	<style>
		* { box-sizing: border-box; margin: 0; }
		html, body { min-height: 100%; background: #0D1F17; color: #F4F0E6; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
		body { display: grid; place-items: center; padding: 24px; }
		main { width: min(1120px, 100%); }
		a { color: #5FD3BC; text-decoration: none; font-weight: 700; }
		video { width: 100%; border: 1px solid rgba(244, 240, 230, .18); border-radius: 24px; box-shadow: 0 32px 90px rgba(0, 0, 0, .36); background: #000; display: block; }
		.header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
		h1 { font-size: clamp(28px, 5vw, 52px); line-height: 1; letter-spacing: -.04em; }
		@media (max-width: 640px) { .header { align-items: flex-start; flex-direction: column; } body { padding: 14px; } video { border-radius: 16px; } }
	</style>
</head>
<body>
	<main>
		<div class="header"><h1>Compass Demo</h1><a href="/">Back to landing</a></div>
		<video src="/demo-compass.mp4" controls autoplay muted playsinline preload="metadata"></video>
	</main>
</body>
</html>`, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store, must-revalidate",
		},
	});
}
