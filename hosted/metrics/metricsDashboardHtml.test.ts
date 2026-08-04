import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("metrics dashboard beta click tile", () => {
	it("labels the total as all-time clicks and renders every aggregate source", async () => {
		const html = await readFile(
			new URL("../../scripts/metrics-dashboard.html", import.meta.url),
			"utf8",
		);

		expect(html).toContain("Beta page clicks — all time");
		expect(html).toContain('id="kpi-beta-clicks"');
		for (const source of ["nav", "hero", "closing", "unknown"]) {
			expect(html).toContain(`betaClicks.bySource.${source}`);
		}
		expect(html).toContain("click events, not unique people");
	});
});
