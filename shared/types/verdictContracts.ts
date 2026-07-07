// Frozen shared seam between the /verify + /verify/confirm services (Lilly) and
// the Solana tx-decode module (Fran). Imported as `@shared/verdictContracts`.
// Types only — no runtime logic. See docs/compass-demo-day/decode-handoff.md
// for the authoritative frozen block; D19/D20/D21 in the run tracker for provenance.

import type { VersionedTransactionResponse } from "@solana/web3.js";

export type IntendedEffect = {
  actionKind: "transfer" | "swap" | "unknown";
  recipient?: string; // destination pubkey (SOL) or destination token-account owner (SPL)
  lamports?: number; // SOL transfer amount, native (NOT USD — see "Amount units")
  tokenAmount?: string; // SPL amount in base units, as a string (avoid float precision loss)
  mint?: string; // SPL mint
  amountUsd?: number; // only for the policy cap check; NOT used by the confirm compare
};

export type ActualEffect =
  | { unavailable: true }
  | {
      unavailable: false;
      recipient?: string;
      lamports?: number;
      tokenAmount?: string;
      mint?: string;
      extraInstructions: string[]; // e.g. ["SetAuthority", "Approve", "Transfer(unexpected)"]
    };

export type Discrepancy = {
  field: "recipient" | "amount" | "mint" | "extra_instruction";
  expected?: string;
  actual?: string;
};

export type DecodedIntent = {
  actionKind: "transfer" | "swap" | "unknown";
  recipient?: string;
  lamports?: number;
  tokenAmount?: string;
  mint?: string;
  flags: {
    authority_change?: boolean;
    unlimited_delegate?: boolean;
    unknown_program?: boolean;
  };
};

export type DeriveActualEffect = (
  tx: VersionedTransactionResponse,
  intended: IntendedEffect,
) => ActualEffect;

export type DecodeTransaction = (unsignedTxBase64: string) => DecodedIntent;
