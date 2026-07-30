import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { sha256Hex } from "../back/services/magicBlockDevnetPreflightCanonical";
import {
	createMagicBlockAuditSignerFromEnv,
	createMagicBlockOnchainAuditVerifier,
	createMagicBlockOnchainAuditSubmitter,
	createMagicBlockRouterRpc,
	createSolanaDevnetRpc,
} from "../back/services/magicBlockOnchainAudit";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA,
	type MagicBlockOnchainAuditRegistration,
} from "../back/services/magicBlockOnchainAuditContracts";
import {
	consumeMagicBlockSmokeAuthorization,
	classifyMagicBlockSmokeReconciliation,
	createMagicBlockSmokeAuthorization,
	importLegacyPendingMagicBlockSmoke,
	persistPreparedMagicBlockSmoke,
	readMagicBlockSmokeState,
	reconcileMagicBlockSmoke,
} from "./magicBlockDevnetSmokeState";

const mode = process.argv[2];
const stateDirectory = resolve(
	process.cwd(),
	process.env.COMPASS_MAGICBLOCK_DEVNET_SMOKE_STATE_DIR?.trim() ||
		".compass-magicblock-devnet-smoke",
);
const now = () => new Date().toISOString();

if (mode === "authorize") {
	const authorization = createMagicBlockSmokeAuthorization({
		stateDirectory,
		authorizationNonce: randomUUID(),
		createdAt: now(),
	});
	writePublicResult({
		mode: "authorization-created",
		authorizationNonce: authorization.authorizationNonce,
		createdAt: authorization.createdAt,
	});
} else if (mode === "reconcile") {
	await reconcilePendingSmoke();
} else if (mode === "submit") {
	await submitAuthorizedSmoke();
} else {
	throw new Error(
		"Smoke mode is required: authorize, reconcile, or submit.",
	);
}

async function reconcilePendingSmoke(): Promise<void> {
	let state = readMagicBlockSmokeState(stateDirectory);
	if (!state) {
		const legacySignature =
			process.env.COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNATURE?.trim();
		if (!legacySignature) {
			throw new Error("No durable or legacy prepared signature is available.");
		}
		const legacySigner =
			process.env.COMPASS_MAGICBLOCK_DEVNET_RECONCILE_SIGNER?.trim() ||
			process.env.COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY?.trim();
		if (!legacySigner) {
			throw new Error("The prepared public signer is required for reconciliation.");
		}
		state = importLegacyPendingMagicBlockSmoke({
			stateDirectory,
			signer: legacySigner,
			signature: legacySignature,
			importedAt: now(),
		});
	}
	if (state.status === "authorized") {
		throw new Error("Authorization has not started a smoke transaction.");
	}
	if (state.status === "active") {
		const reconciled = reconcileMagicBlockSmoke({
			stateDirectory,
			outcome: "not_submitted",
			reconciledAt: now(),
		});
		writePublicResult({
			mode: "reconcile-only",
			state: reconciled.status,
			outcome: reconciled.outcome,
		});
		return;
	}
	if (state.status === "reconciled") {
		writePublicResult({
			mode: "reconcile-only",
			state: state.status,
			outcome: state.outcome,
			...(state.signature ? { signature: state.signature } : {}),
		});
		return;
	}

	const verificationOptions = {
		confirmationAttempts: 1,
		waitBetweenAttempts: async () => undefined,
	} as const;
	const expected =
		state.status === "pending"
			? {
					expectedCommitmentDigest: state.commitmentDigest,
					expectedMemo: state.memo,
				}
			: {};
	const [solana, magicRouter] = await Promise.all([
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: createSolanaDevnetRpc(),
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
			...expected,
		}),
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: createMagicBlockRouterRpc(),
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
			...expected,
		}),
	]);
	const outcome = classifyMagicBlockSmokeReconciliation(solana, magicRouter);
	if (!outcome) {
		writePublicResult({
			mode: "reconcile-only",
			state: state.status,
			signature: state.signature,
			solana: publicReconciliationResult(solana),
			magicRouter: publicReconciliationResult(magicRouter),
			outcome: "ambiguous",
		});
		throw new Error(
			"Prepared signature reconciliation remains ambiguous; new submission stays blocked.",
		);
	}
	const reconciled = reconcileMagicBlockSmoke({
		stateDirectory,
		outcome,
		signature: state.signature,
		reconciledAt: now(),
	});
	writePublicResult({
		mode: "reconcile-only",
		state: reconciled.status,
		outcome: reconciled.outcome,
		signature: reconciled.signature,
		solana: publicReconciliationResult(solana),
		magicRouter: publicReconciliationResult(magicRouter),
	});
}

async function submitAuthorizedSmoke(): Promise<void> {
	const authorizationNonce =
		process.env.COMPASS_MAGICBLOCK_DEVNET_AUTHORIZATION_NONCE?.trim();
	if (!authorizationNonce) {
		throw new Error("A one-run MagicBlock smoke authorization nonce is required.");
	}
	const signer = requireSigner();
	const auditEventId = `aud_smoke_${randomUUID()}`;
	const observationId = `obs_smoke_${randomUUID()}`;
	consumeMagicBlockSmokeAuthorization({
		stateDirectory,
		authorizationNonce,
		auditEventId,
		observationId,
		startedAt: now(),
	});

	const digest = (label: string) =>
		sha256Hex(
			"compass.magicblock-devnet-smoke/v1\0",
			auditEventId,
			"\0",
			label,
		);
	const registration = await createMagicBlockOnchainAuditSubmitter({
		signer,
		confirmationAttempts: 20,
		waitBetweenAttempts: () =>
			new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
	}).register(
		{
			schemaVersion: MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA,
			cluster: "devnet",
			observationId,
			auditEventId,
			transactionDigest: digest("transaction"),
			requestDigest: digest("request"),
			resultDigest: digest("result"),
			attestationDigest: digest("attestation"),
			previousLedgerDigest: "0".repeat(64),
			ledgerDigest: digest("ledger"),
			outcome: "review_required",
		},
		async (prepared) => {
			persistPreparedMagicBlockSmoke({
				stateDirectory,
				authorizationNonce,
				signer: signer.publicKey.toBase58(),
				prepared,
				preparedAt: now(),
			});
			return prepared;
		},
	);

	if (registration.status !== "confirmed") {
		throw new Error(
			`Devnet audit submission is retryable: ${registration.code}${
				registration.signature ? ` (${registration.signature})` : ""
			}. Reconcile the durable state before any new authorization.`,
		);
	}
	reconcileMagicBlockSmoke({
		stateDirectory,
		outcome: "confirmed",
		signature: registration.signature,
		reconciledAt: now(),
	});
	writePublicResult({
		mode: "submitted-and-confirmed",
		auditEventId,
		signer: registration.signer,
		signature: registration.signature,
		slot: registration.slot,
		commitmentDigest: registration.commitmentDigest,
		explorerUrl: `https://explorer.solana.com/tx/${registration.signature}?cluster=devnet`,
	});
}

function requireSigner() {
	const signer = createMagicBlockAuditSignerFromEnv();
	if (!signer) {
		throw new Error(
			"Dedicated devnet audit signer unavailable; configure the secret key or absolute key-file path and optional public-key pin.",
		);
	}
	return signer;
}

function publicReconciliationResult(
	registration: MagicBlockOnchainAuditRegistration,
): Readonly<Record<string, unknown>> {
	return registration.status === "confirmed"
		? {
				status: registration.status,
				signature: registration.signature,
				slot: registration.slot,
			}
		: {
				status: registration.status,
				code: registration.code,
				...(registration.routerDiagnostics
					? { routerDiagnostics: registration.routerDiagnostics }
					: {}),
			};
}

function writePublicResult(value: Readonly<Record<string, unknown>>): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
