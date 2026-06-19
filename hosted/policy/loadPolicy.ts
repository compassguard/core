import { DEFAULT_POLICY } from "./defaultPolicy";
import type { CompassPolicy } from "@shared/policyContracts";
import { validateCompassPolicy } from "@back/guardrail/policy/policySchema";

let cachedDefaultPolicy: CompassPolicy | undefined;

export function loadDefaultPolicy(): CompassPolicy {
	cachedDefaultPolicy ??= loadPolicy(DEFAULT_POLICY);

	return cachedDefaultPolicy;
}

export function loadPolicy(policy: unknown): CompassPolicy {
	const validation = validateCompassPolicy(policy);
	if (validation.ok === false) {
		throw new Error(
			`Invalid policy schema: ${validation.errors
				.map((item) => `${item.path}: ${item.message}`)
				.join("; ")}`,
		);
	}

	return validation.policy;
}
