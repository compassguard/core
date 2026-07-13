import { randomUUID } from "node:crypto";

import {
	classifyToolCall,
	createActionCandidate,
} from "@back/guardrail/execution/executionGateway";
import { getPostHogClient } from "@back/posthog/posthogClient";
import { HOSTED_DECISIONS } from "@shared/evaluationContracts";
import type { PolicyEvaluationContext } from "@shared/policyContracts";
import type { TrustPolicy, TrustProvider } from "@shared/trustContracts";
import type { IntendedEffect } from "@shared/verdictContracts";

import {
	collapseToHostedDecision,
	riskLevelForHostedDecision,
} from "../evaluate/hostedDecision";
import { derivePolicyContext } from "../policy/policyContext";
import { evaluateAction } from "../policy/policyEngine";
import { loadDefaultPolicy } from "../policy/loadPolicy";
import { applyTrustSignal } from "../trust/trustSignal";
import type { VerdictStore } from "../verdict/verdictStoreTypes";
import { buildHumanExplanation } from "./humanExplanation";
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
	/**
	 * Optional counterparty screening. Omit it and behaviour is unchanged.
	 *
	 * The signal is NEGATIVE EVIDENCE ONLY: applyTrustSignal takes max() on
	 * strictness, so a provider can push a decision toward deny and never away
	 * from it. It cannot raise a cap or override the denylist — it never sees
	 * them, only the verdict the deterministic engine already reached.
	 */
	trustProvider?: TrustProvider;
	trustPolicy?: TrustPolicy;
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

			const baseDecision = collapseToHostedDecision(evaluation.decision);

			// Counterparty screening. Consulted whenever the engine did not already
			// deny and there is a recipient to screen — a known drainer has to be
			// caught even on a payment the deterministic rules were happy with, so
			// this cannot be narrowed to the unknown-recipient branch.
			//
			// Fail-open by construction: a provider that is down returns NO_SIGNAL,
			// which imposes nothing. That is only safe because the signal can never
			// relax a decision (applyTrustSignal), so an outage costs a missed extra
			// caution rather than a wrongly-permitted payment.
			let decision = baseDecision;
			let reasons = evaluation.reasonCodes;

			if (
				deps.trustProvider &&
				context.recipient_address &&
				baseDecision !== HOSTED_DECISIONS.DENY
			) {
				const signal = await deps.trustProvider.screen(
					context.recipient_address,
				);
				const refined = applyTrustSignal(
					baseDecision,
					signal,
					deps.trustPolicy,
				);

				decision = refined.decision;
				if (refined.addedReasons.length > 0) {
					reasons = [...reasons, ...refined.addedReasons];
				}
				// SEAM: signal.evidence carries the provider's signed response, which is
				// what makes a screening-driven verdict independently auditable. Persisting
				// it needs a VerdictStore contract change (a decision-evidence column), so
				// it is deliberately left for that change rather than half-wired here.
			}

			// Keyed on the FINAL decision, not evaluation.decision: a payment the
			// trust layer escalated to deny must not still report riskLevel "low".
			const riskLevel = riskLevelForHostedDecision(decision);
			const humanExplanation = buildHumanExplanation(decision, reasons);
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
			};
		},
	};
}
