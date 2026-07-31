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
	collectMagicBlockSmokeEndpointExpiryEvidence,
	createMagicBlockSmokeAuthorization,
	importLegacyMagicBlockTransactionEvidence,
	importLegacyPendingMagicBlockSmoke,
	persistPreparedMagicBlockSmoke,
	quarantineLegacyPendingMagicBlockSmoke,
	readMagicBlockSmokeState,
	reconcileMagicBlockSmoke,
} from "./magicBlockDevnetSmokeState";
import {
	MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT,
	MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT,
} from "./magicBlockDevnetSmokeStateContracts";

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
} else if (mode === "import-legacy-evidence") {
	importLegacyEvidence();
} else if (mode === "quarantine-legacy") {
	await quarantineLegacySmoke();
} else if (mode === "submit") {
	await submitAuthorizedSmoke();
} else {
	throw new Error(
		"Smoke mode is required: authorize, import-legacy-evidence, quarantine-legacy, reconcile, or submit.",
	);
}

function importLegacyEvidence(): void {
	const evidence = importLegacyMagicBlockTransactionEvidence({
		stateDirectory,
		evidenceFile: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_FILE",
		),
		authorizationId: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_AUTHORIZATION_ID",
		),
		operator: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_OPERATOR",
		),
		reason: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_REASON",
		),
		authorizedAt: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_AUTHORIZED_AT",
		),
		riskAcknowledgement: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT",
		),
		importedAt: now(),
	});
	writePublicResult({
		mode: "legacy-evidence-imported",
		state: evidence.status,
		signature: evidence.signature,
		transactionDigest: evidence.evidenceImport?.transactionDigest,
		recentBlockhash: evidence.evidenceImport?.recentBlockhash,
		authorizationId: evidence.evidenceImport?.authorizationId,
		importedAt: evidence.evidenceImport?.importedAt,
	});
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
	if (state.status === "quarantined") {
		writePublicResult({
			mode: "reconcile-only",
			state: state.status,
			historicalOutcome: state.historicalOutcome,
			signature: state.legacyEvidence.signature,
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
			: state.originalEvidence?.commitmentDigest &&
				  state.originalEvidence.memo
				? {
						expectedCommitmentDigest:
							state.originalEvidence.commitmentDigest,
						expectedMemo: state.originalEvidence.memo,
					}
				: {};
	const solanaRpc = createSolanaDevnetRpc();
	const magicRouterRpc = createMagicBlockRouterRpc();
	const [solana, magicRouter] = await Promise.all([
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: solanaRpc,
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
			...expected,
		}),
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: magicRouterRpc,
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
			...expected,
		}),
	]);
	const recentBlockhash =
		state.status === "pending"
			? state.recentBlockhash
			: state.evidenceImport?.recentBlockhash ??
				state.originalEvidence?.recentBlockhash;
	const expiry = recentBlockhash
		? {
				solana: await collectMagicBlockSmokeEndpointExpiryEvidence(
					solanaRpc,
					"solana_devnet",
					state.signature,
					recentBlockhash,
				),
				magicRouter: await collectMagicBlockSmokeEndpointExpiryEvidence(
					magicRouterRpc,
					"magic_router",
					state.signature,
					recentBlockhash,
				),
				...(state.status === "pending"
					? { lastValidBlockHeight: state.lastValidBlockHeight }
					: {}),
			}
		: undefined;
	const outcome = classifyMagicBlockSmokeReconciliation(
		solana,
		magicRouter,
		expiry,
	);
	if (!outcome) {
		writePublicResult({
			mode: "reconcile-only",
			state: state.status,
			signature: state.signature,
			solana: publicReconciliationResult(solana),
			magicRouter: publicReconciliationResult(magicRouter),
			...(expiry ? { expiry } : {}),
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
		...(outcome === "expired_not_landed" && expiry
			? { expiryEvidence: expiry }
			: {}),
	});
	writePublicResult({
		mode: "reconcile-only",
		state: reconciled.status,
		outcome: reconciled.outcome,
		signature: reconciled.signature,
		solana: publicReconciliationResult(solana),
		magicRouter: publicReconciliationResult(magicRouter),
		...(expiry ? { expiry } : {}),
	});
}

async function quarantineLegacySmoke(): Promise<void> {
	const state = readMagicBlockSmokeState(stateDirectory);
	if (state?.status === "quarantined") {
		const administration = state.administration;
		if (
			administration.authorizationId !==
				requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_AUTHORIZATION_ID") ||
			administration.incidentReference !==
				requireEnv(
					"COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_INCIDENT_REFERENCE",
				) ||
			administration.operator !==
				requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_OPERATOR") ||
			administration.reason !==
				requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_REASON") ||
			administration.authorizedAt !==
				requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_AUTHORIZED_AT") ||
			administration.acknowledgement !==
				requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_ACKNOWLEDGEMENT")
		) {
			throw new Error("MagicBlock legacy quarantine conflicts.");
		}
		writePublicResult({
			mode: "quarantine-legacy",
			state: state.status,
			historicalOutcome: state.historicalOutcome,
			signature: state.legacyEvidence.signature,
			valueTransferLamports: state.scope.valueTransferLamports,
			genericExecutionFenceReleased:
				state.scope.genericExecutionFenceReleased,
			quarantinedAt: administration.quarantinedAt,
		});
		return;
	}
	if (
		state?.status !== "legacy_pending" ||
		state.sourceSchemaVersion !==
			"compass.magicblock-devnet-smoke-state/v1" ||
		state.originalEvidence !== undefined ||
		state.evidenceImport !== undefined
	) {
		throw new Error("Exact signature-only v1 legacy pending state is required.");
	}
	const observedAt = now();
	const verificationOptions = {
		confirmationAttempts: 1,
		waitBetweenAttempts: async () => undefined,
	} as const;
	const [solana, magicRouter] = await Promise.all([
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: createSolanaDevnetRpc(),
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
		}),
		createMagicBlockOnchainAuditVerifier({
			...verificationOptions,
			rpc: createMagicBlockRouterRpc(),
		}).verify({
			signature: state.signature,
			expectedSigner: state.signer,
		}),
	]);
	const outcome = classifyMagicBlockSmokeReconciliation(solana, magicRouter);
	if (outcome === "confirmed" || outcome === "failed") {
		const reconciled = reconcileMagicBlockSmoke({
			stateDirectory,
			outcome,
			signature: state.signature,
			reconciledAt: now(),
		});
		writePublicResult({
			mode: "quarantine-legacy",
			state: reconciled.status,
			outcome: reconciled.outcome,
			signature: reconciled.signature,
		});
		return;
	}
	const quarantined = quarantineLegacyPendingMagicBlockSmoke({
		stateDirectory,
		authorizationId: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_AUTHORIZATION_ID",
		),
		incidentReference: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_INCIDENT_REFERENCE",
		),
		operator: requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_OPERATOR"),
		reason: requireEnv("COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_REASON"),
		authorizedAt: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_AUTHORIZED_AT",
		),
		quarantinedAt: now(),
		acknowledgement: requireEnv(
			"COMPASS_MAGICBLOCK_DEVNET_QUARANTINE_ACKNOWLEDGEMENT",
		),
		endpointObservations: {
			solana: {
				endpoint: "solana_devnet",
				signature: state.signature,
				status: quarantineObservationStatus(solana),
				observedAt,
			},
			magicRouter: {
				endpoint: "magic_router",
				signature: state.signature,
				status: quarantineObservationStatus(magicRouter),
				observedAt,
			},
		},
	});
	writePublicResult({
		mode: "quarantine-legacy",
		state: quarantined.status,
		historicalOutcome: quarantined.historicalOutcome,
		signature: quarantined.legacyEvidence.signature,
		valueTransferLamports: quarantined.scope.valueTransferLamports,
		genericExecutionFenceReleased:
			quarantined.scope.genericExecutionFenceReleased,
		quarantinedAt: quarantined.administration.quarantinedAt,
	});
}

function quarantineObservationStatus(
	registration: MagicBlockOnchainAuditRegistration,
): "confirmed" | "execution_failed" | "ambiguous" | "unavailable" {
	if (registration.status === "confirmed") return "confirmed";
	if (registration.code === "TRANSACTION_EXECUTION_FAILED") {
		return "execution_failed";
	}
	if (registration.code === "ROUTER_UNAVAILABLE") return "unavailable";
	return "ambiguous";
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
	await reconcilePendingSmoke();
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

function requireEnv(key: string): string {
	const value = process.env[key]?.trim();
	if (!value) throw new Error(`Required ${key} is unavailable.`);
	if (
		key.endsWith("_RISK_ACKNOWLEDGEMENT") &&
		value !== MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT
	) {
		throw new Error("Legacy evidence risk acknowledgement is not exact.");
	}
	if (
		key.endsWith("_QUARANTINE_ACKNOWLEDGEMENT") &&
		value !== MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT
	) {
		throw new Error("Legacy quarantine acknowledgement is not exact.");
	}
	return value;
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
