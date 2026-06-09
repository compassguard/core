import { describe, expect, it } from "vitest";

import {
	loadDefaultPolicy,
	loadPolicyFromString,
} from "../policy/loadPolicy";
import { validateCompassPolicy } from "../policy/policySchema";

describe("policy loader", () => {
	it("loads the default conservative policy from YAML", () => {
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
			bridges: {
				default: "require_approval",
				max_usd_per_day: 100,
				allowed_chains: ["Solana", "Base"],
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

	it("loads a policy from a YAML string", () => {
		const policy = loadPolicyFromString(`
policy_id: test-policy
version: 0.1.0
default: require_approval
read_only:
  default: allow
transfers:
  max_usd_without_approval: 10
  require_approval_for_unknown_recipient: true
  blocked_recipients: []
swaps:
  max_usd_without_approval: 25
  max_slippage_bps: 300
  require_approval_for_unknown_token: true
  allowed_protocols: [Jupiter]
conditional_buys:
  default: require_approval
  max_slippage_bps: 300
  max_oracle_age_seconds: 60
  max_confidence_bps: 100
bridges:
  default: require_approval
  max_usd_per_day: 100
  allowed_chains: [Solana]
signing:
  sign_message: require_approval
  sign_transaction: require_simulation
  sign_and_send_transaction: deny_unless_compass_built
blocked:
  unknown_program: require_approval
  unlimited_delegate: deny
  authority_change: deny
  suspicious_recipient: deny
`);

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
			policy_id: "bad-policy",
			version: "0.1.0",
			default: "launch_missiles",
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
			bridges: {
				default: "require_approval",
				max_usd_per_day: 100,
				allowed_chains: ["Solana"],
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

	it("throws safe explicit errors for invalid YAML", () => {
		expect(() => loadPolicyFromString("default: [unterminated")).toThrow(
			/Invalid policy YAML/,
		);
		expect(() => loadPolicyFromString("default: [unterminated")).not.toThrow(
			/unterminated/,
		);
	});

	it("throws explicit validation errors for invalid schema", () => {
		expect(() =>
			loadPolicyFromString(`
policy_id: bad-policy
version: 0.1.0
default: allow
read_only:
  default: allow
transfers:
  require_approval_for_unknown_recipient: true
  blocked_recipients: []
swaps:
  max_usd_without_approval: 25
  max_slippage_bps: 300
  require_approval_for_unknown_token: true
  allowed_protocols: [Jupiter]
conditional_buys:
  default: require_approval
  max_slippage_bps: 300
  max_oracle_age_seconds: 60
  max_confidence_bps: 100
bridges:
  default: require_approval
  max_usd_per_day: 100
  allowed_chains: [Solana]
signing:
  sign_message: require_approval
  sign_transaction: require_simulation
  sign_and_send_transaction: deny_unless_compass_built
blocked:
  unknown_program: require_approval
  unlimited_delegate: deny
  authority_change: deny
  suspicious_recipient: deny
`),
		).toThrow(/Invalid policy schema: transfers\.max_usd_without_approval/);
	});
});
