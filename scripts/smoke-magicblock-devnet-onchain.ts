import { randomUUID } from "node:crypto";

import { sha256Hex } from "../back/services/magicBlockDevnetPreflightCanonical";
import {
	createMagicBlockAuditSignerFromEnv,
	createMagicBlockOnchainAuditSubmitter,
} from "../back/services/magicBlockOnchainAudit";
import { MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA } from "../back/services/magicBlockOnchainAuditContracts";

const signer = createMagicBlockAuditSignerFromEnv();
if (!signer) {
	throw new Error(
		"Dedicated devnet audit signer unavailable; configure the secret key or absolute key-file path and optional public-key pin.",
	);
}

const auditEventId = `aud_smoke_${randomUUID()}`;
const digest = (label: string) =>
	sha256Hex("compass.magicblock-devnet-smoke/v1\0", auditEventId, "\0", label);
const registration = await createMagicBlockOnchainAuditSubmitter({
	signer,
	confirmationAttempts: 20,
	waitBetweenAttempts: () =>
		new Promise((resolve) => setTimeout(resolve, 1_000)),
}).register({
	schemaVersion: MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA,
	cluster: "devnet",
	observationId: `obs_smoke_${randomUUID()}`,
	auditEventId,
	transactionDigest: digest("transaction"),
	requestDigest: digest("request"),
	resultDigest: digest("result"),
	attestationDigest: digest("attestation"),
	previousLedgerDigest: "0".repeat(64),
	ledgerDigest: digest("ledger"),
	outcome: "review_required",
});

if (registration.status !== "confirmed") {
	throw new Error(
		`Devnet audit submission is retryable: ${registration.code}${
			registration.signature ? ` (${registration.signature})` : ""
		}`,
	);
}

process.stdout.write(
	`${JSON.stringify(
		{
			auditEventId,
			signer: registration.signer,
			signature: registration.signature,
			slot: registration.slot,
			commitmentDigest: registration.commitmentDigest,
			explorerUrl: `https://explorer.solana.com/tx/${registration.signature}?cluster=devnet`,
		},
		null,
		2,
	)}\n`,
);
