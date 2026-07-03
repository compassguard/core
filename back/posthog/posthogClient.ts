import { PostHog } from "posthog-node";

let _client: PostHog | undefined;

export function getPostHogClient(): PostHog {
	if (!_client) {
		_client = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
			host: process.env.POSTHOG_HOST,
			enableExceptionAutocapture: true,
		});
	}
	return _client;
}

export function getInstallationDistinctId(): string {
	return process.env.COMPASS_INSTALLATION_ID ?? "compass-system";
}
