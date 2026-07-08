/**
 * Registry of publicly-served docs. Each entry maps a clean URL slug (/docs/<slug>)
 * to a markdown file under public/. The markdown lives in public/ so it is ALSO
 * reachable as a raw static asset (e.g. /skill-onboard.md — the agent-skill contract);
 * the /docs/<slug> route below reads the same file, so there is one source of truth.
 *
 * To add a doc: drop the file in public/, add an entry here, and add its filename to
 * `outputFileTracingIncludes` in next.config.mjs (the glob ./public/*.md already covers it).
 */
export type DocEntry = {
	slug: string;
	file: string;
	title: string;
	description: string;
	/** Stable alias URL, when the doc is also published at a fixed path (e.g. an agent-skill fetch URL). */
	agentUrl?: string;
};

export const DOCS: DocEntry[] = [
	{
		slug: "quickstart",
		file: "quickstart.md",
		title: "Compass — Dev Quickstart",
		description:
			"One-page dev quickstart: the claude mcp add snippet, a curl POST /v1/verify example, and how to get an API key.",
	},
	{
		slug: "onboarding",
		file: "skill-onboard.md",
		title: "Compass Onboarding (agent skill)",
		description:
			"Runbook a coding agent fetches to guide a user through testing Compass, the execution firewall for AI agents on Solana.",
		agentUrl: "/skill-onboard.md",
	},
];

export function findDoc(slug: string): DocEntry | undefined {
	return DOCS.find((doc) => doc.slug === slug);
}
