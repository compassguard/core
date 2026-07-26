import { randomUUID } from "node:crypto";

import {
	classifyToolCall,
	createActionCandidate,
} from "@back/guardrail/execution/executionGateway";
import { getPostHogClient } from "@back/posthog/posthogClient";
import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import type { IntentSource, MandateStore } from "@shared/mandateContracts";
import type { PolicyEvaluationContext } from "@shared/policyContracts";
import type { IntendedEffect } from "@shared/verdictContracts";

import {
	collapseToHostedDecision,
	hostedRiskLevelFor,
} from "../evaluate/hostedDecision";
import { derivePolicyContext } from "../policy/policyContext";
import { evaluateAction } from "../policy/policyEngine";
import { loadDefaultPolicy } from "../policy/loadPolicy";
import type { VerdictStore } from "../verdict/verdictStoreTypes";
import { buildHumanExplanation } from "./humanExplanation";
import { VERIFY_JUDGE_REASON_UNAVAILABLE } from "./verifyJudge";
import type { VerifyJudge } from "./verifyJudge";
import type {
	VerifyActionRequest,
	VerifyActionResponse,
	VerifyCaller,
	VerifyService,
} from "./verifyContracts";

export type VerifyServiceDependencies = {
	verdictStore: VerdictStore;
	/** Called (best-effort) when the DECIDED write fails; the verdict is still returned. */
	captureException?: (error: unknown) => void;
	isoNow?: () => string;
	/** Trusted-anchor lookup for the mandate judge; absent ⇒ deterministic-only ("none"). */
	mandateStore?: MandateStore;
	/** The inline mandate judge (self_report mode); absent ⇒ deterministic-only ("none"). */
	verifyJudge?: VerifyJudge;
};

export function createVerifyService(
	deps: VerifyServiceDependencies,
): VerifyService {
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());
	const captureException =
		deps.captureException ??
		((error: unknown) => {
			getPostHogClient().captureException(
				error instanceof Error ? error : new Error(String(error)),
				undefined,
				{ event_context: "hosted_verify_decided_write_failed" },
			);
		});

	return {
		async verifyAction(
			request: VerifyActionRequest,
			caller?: VerifyCaller,
		): Promise<VerifyActionResponse> {
			const correlationId = randomUUID();
			const requestedAt = request.requestedAt ?? isoNow();
			const args = request.arguments ?? {};
			const actionKind = request.intent?.kind ?? "unknown";

			// Deterministic-only: classify by tool name + evaluate policy. No LLM router,
			// no LLM judge, no audit-write dependency (R2/R3).
			const classification = classifyToolCall({
				toolName: request.toolName,
				mutates: true,
			});
			const context: PolicyEvaluationContext = request.intent?.kind
				? derivePolicyContext(request.intent.kind, args)
				: {};
			const candidate = createActionCandidate({
				id: correlationId,
				chain: "solana",
				network: "solana",
				toolName: request.toolName,
				actionKind,
				createdAt: requestedAt,
				params: args,
			});
			const evaluation = evaluateAction({
				candidate,
				classification,
				context,
				policy: loadDefaultPolicy(),
			});

			// Mandate judge (self_report mode): runs ONLY when wired AND the caller's identity
			// has a registered mandate AND the request states a purpose. Tier-1 asymmetry: a
			// deterministic DENY is final and never escalates. The judge may keep or tighten,
			// never loosen (strictness clamp inside createVerifyJudge).
			let compassDecision = evaluation.decision;
			let reasons: string[] = [...evaluation.reasonCodes];
			let intentSource: IntentSource = "none";
			let judgeRationale: string | undefined;
			let judgeChangedDecision = false;

			const statedPurpose = request.intent?.statedPurpose;
			if (
				deps.verifyJudge !== undefined &&
				deps.mandateStore !== undefined &&
				statedPurpose !== undefined &&
				evaluation.decision !== COMPASS_DECISIONS.DENY
			) {
				// Trusted-identity precedence: credential-derived email over self-reported userId.
				const ownerId = caller?.authenticatedEmail ?? request.userId;
				const mandate =
					ownerId !== undefined
						? await deps.mandateStore.get(ownerId).catch((error: unknown) => {
								// A mandate-store hiccup must not 500 the verify path; treated as
								// no-mandate (deterministic fallback), surfaced to telemetry.
								captureException(error);
								return undefined;
							})
						: undefined;
				if (mandate !== undefined) {
					const judged = await deps
						.verifyJudge({
							toolName: request.toolName,
							actionKind,
							deterministicDecision: evaluation.decision,
							reasonCodes: evaluation.reasonCodes,
							args,
							statedPurpose,
							mandate,
						})
						.catch((error: unknown) => {
							captureException(error);
							return { ran: false as const };
						});
					if (judged.ran) {
						compassDecision = judged.decision;
						reasons = [...reasons, ...judged.reasonCodes];
						judgeRationale = judged.rationale;
						judgeChangedDecision = judged.decision !== evaluation.decision;
						intentSource = "self_report";
					} else {
						// Fail-honest: a structural-only check is never presented as a mandate check.
						reasons = [...reasons, VERIFY_JUDGE_REASON_UNAVAILABLE];
					}
				}
			}

			const decision = collapseToHostedDecision(compassDecision);
			const riskLevel = hostedRiskLevelFor(compassDecision);
			let humanExplanation = buildHumanExplanation(decision, reasons);
			if (judgeChangedDecision && judgeRationale !== undefined) {
				humanExplanation = `${humanExplanation} Mandate judge: ${judgeRationale}`;
			}
			// SEAM (D4-v2 / R2): native intended dimensions — lamports / tokenAmount /
			// mint — are populated here once a verify-side decode source (Fran's
			// decodeTransaction, injection ①) is wired. There is no such source in
			// verify today (policy context carries only recipient_address + amount_usd),
			// so they stay undefined and are NOT fabricated from policy context. Until
			// the decode source lands, the fail-closed compareEffects contract (a
			// declared-but-unconfirmable dimension is never a silent match) covers the gap.
			const intendedEffect: IntendedEffect = {
				actionKind,
				recipient: context.recipient_address,
				amountUsd: context.amount_usd,
			};

			// Best-effort DECIDED write: the verdict is returned regardless of write
			// success (R3/R9 — no degraded denial). Awaited so the record exists before
			// the caller holds the correlationId in the common case (F38).
			try {
				await deps.verdictStore.putDecided({
					correlationId,
					decision,
					reasons,
					humanExplanation,
					intendedEffect,
					decidedAt: requestedAt,
					// Attribution: forward who/which-session so verdicts are not stored anonymous
					// (the /verify request validates these; dropping them was a silent boundary drop).
					userId: request.userId,
					sessionId: request.sessionId,
					// Trustworthy credential-derived identity (D11), server-set from the
					// resolved credential — distinct from the self-reported userId above.
					authenticatedEmail: caller?.authenticatedEmail,
					intentSource,
					...(judgeRationale !== undefined ? { judgeRationale } : {}),
				});
			} catch (error) {
				captureException(error);
			}

			return {
				correlationId,
				decision,
				riskLevel,
				reasons,
				humanExplanation,
				intentSource,
			};
		},
	};
}
