import type {
	PolicyService,
	PolicySnapshotResponse,
} from "./policyContracts";
import { loadDefaultPolicy } from "../policy/loadPolicy";

export function createPolicyService(): PolicyService {
	return {
		getPolicySnapshot(): PolicySnapshotResponse {
			const policy = loadDefaultPolicy();

			return {
				version: policy.version,
				updatedAt: new Date().toISOString(),
				rules: {
					default: policy.default,
					readOnly: {
						default: policy.read_only.default,
					},
					transfers: {
						maxUsdWithoutApproval: policy.transfers.max_usd_without_approval,
						requireApprovalForUnknownRecipient:
							policy.transfers.require_approval_for_unknown_recipient,
						blockedRecipients: policy.transfers.blocked_recipients,
					},
					swaps: {
						maxUsdWithoutApproval: policy.swaps.max_usd_without_approval,
						maxSlippageBps: policy.swaps.max_slippage_bps,
						requireApprovalForUnknownToken:
							policy.swaps.require_approval_for_unknown_token,
						allowedProtocols: policy.swaps.allowed_protocols,
					},
					conditionalBuys: {
						default: policy.conditional_buys.default,
						maxSlippageBps: policy.conditional_buys.max_slippage_bps,
						maxOracleAgeSeconds:
							policy.conditional_buys.max_oracle_age_seconds,
						maxConfidenceBps:
							policy.conditional_buys.max_confidence_bps,
					},
					signing: {
						signMessage: policy.signing.sign_message,
						signTransaction: policy.signing.sign_transaction,
						signAndSendTransaction: policy.signing.sign_and_send_transaction,
					},
					blocked: {
						unknownProgram: policy.blocked.unknown_program,
						unlimitedDelegate: policy.blocked.unlimited_delegate,
						authorityChange: policy.blocked.authority_change,
						suspiciousRecipient: policy.blocked.suspicious_recipient,
					},
				},
			};
		},

		getHealthStatus() {
			return "ok";
		},
	};
}
