import type { DeriveActualEffect } from "@shared/verdictContracts";

/**
 * Default actual-effect deriver used until Fran's Solana decode module is injected.
 *
 * It returns the `unavailable` sentinel — NEVER a fabricated "match" — so a deployment
 * without a real decoder honestly reports `unverified_no_decoder` from /verify/confirm
 * instead of silently claiming every transaction matched (D20-v4 / F41).
 *
 * The real decoder (recipient + native amount from balance deltas, extraInstructions
 * from the instruction set) is Fran's — see docs/compass-demo-day/decode-handoff.md.
 */
export const deriveActualEffectUnavailable: DeriveActualEffect = () => ({
	unavailable: true,
});
