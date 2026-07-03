import { describe, expect, it } from "vitest";

import { validateCompassPolicy } from "@back/guardrail/policy/policySchema";
import { loadDefaultPolicy, loadPolicy } from "@hosted/policy/loadPolicy";

const validPolicy = {
	policy_id: "test-policy",
	version: "0.1.0",
	default: "require_approval",
	read_only: { default: "allow" },
	transfers: {
		max_usd_without_approval: 10,
		require_approval_for_unknown_recipient: true,
		blocked_recipients: [],
	},
	swaps: {
		max_usd_without_approval: 25,
		max_slippage_bps: 300,
		require_approval_for_unknown_token: true,
		allowed_protocols: ["Jupiter"],
	},
	conditional_buys: {
		default: "require_approval",
		max_slippage_bps: 300,
		max_oracle_age_seconds: 60,
		max_confidence_bps: 100,
	},
	signing: {
		sign_message: "require_approval",
		sign_transaction: "require_simulation",
		sign_and_send_transaction: "deny_unless_compass_built",
	},
	blocked: {
		unknown_program: "require_approval",
		unlimited_delegate: "deny",
		authority_change: "deny",
		suspicious_recipient: "deny",
	},
};

describe("policy loader", () => {
	it("loads the default conservative policy", () => {
		const policy = loadDefaultPolicy();

		expect(policy).toMatchObject({
			policy_id: "default-conservative",
			version: "0.1.0",
			default: "require_approval",
			read_only: { default: "allow" },
			transfers: {
				max_usd_without_approval: 10,
				require_approval_for_unknown_recipient: true,
				blocked_recipients: ["known_bad_address"],
			},
			swaps: {
				max_usd_without_approval: 25,
				max_slippage_bps: 300,
				require_approval_for_unknown_token: true,
				allowed_protocols: ["Jupiter", "Raydium", "Orca"],
			},
			conditional_buys: {
				default: "require_approval",
				max_slippage_bps: 300,
				max_oracle_age_seconds: 60,
				max_confidence_bps: 100,
			},
			signing: {
				sign_message: "require_approval",
				sign_transaction: "require_simulation",
				sign_and_send_transaction: "deny_unless_compass_built",
			},
			blocked: {
				unknown_program: "require_approval",
				unlimited_delegate: "deny",
				authority_change: "deny",
				suspicious_recipient: "deny",
			},
		});
	});

	it("memoizes the default policy instance", () => {
		expect(loadDefaultPolicy()).toBe(loadDefaultPolicy());
	});

	it("loads a policy from an object", () => {
		const policy = loadPolicy(validPolicy);

		expect(policy.policy_id).toBe("test-policy");
		expect(policy.swaps.allowed_protocols).toEqual(["Jupiter"]);
	});

	it("returns schema errors with field paths for missing required fields", () => {
		const result = validateCompassPolicy({});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.errors).toContainEqual(
				expect.objectContaining({
					path: "policy_id",
					message: expect.stringContaining("required"),
				}),
			);
			expect(result.errors).toContainEqual(
				expect.objectContaining({
					path: "transfers.max_usd_without_approval",
				}),
			);
		}
	});

	it("returns schema errors with field paths for invalid policy outcomes", () => {
		const result = validateCompassPolicy({
			...validPolicy,
			policy_id: "bad-policy",
			default: "launch_missiles",
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.errors).toContainEqual(
				expect.objectContaining({
					path: "default",
					message: expect.stringContaining("Invalid policy outcome"),
				}),
			);
		}
	});

	it("throws explicit validation errors for invalid schema", () => {
		expect(() =>
			loadPolicy({
				...validPolicy,
				transfers: {
					require_approval_for_unknown_recipient: true,
					blocked_recipients: [],
				},
			}),
		).toThrow(/Invalid policy schema: transfers\.max_usd_without_approval/);
	});
});
