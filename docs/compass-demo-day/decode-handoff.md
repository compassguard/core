# Decode module — handoff for Fran

**Goal:** you build the Solana transaction-decode layer. It plugs into the `/verify` +
`/verify/confirm` services through **two frozen function interfaces** that are *injected* — so you
never touch those files, and your module drops in with zero integration edits the moment it matches
these signatures.

Base branch: `main` (`fd38f71`). Work on your own branch off `main`. `@solana/web3.js@^1.98.4` is
already a dependency (`package.json:56`).

---

## What you own — two pure functions (they share one instruction-parsing core)

### 1. `deriveActualEffect` — confirm-side (phase 2, `/verify/confirm`)

Parse a **confirmed** transaction into its real on-chain effect, so the endpoint can compare it to
what was intended and flag divergence.

```ts
function deriveActualEffect(
  confirmedTx: import("@solana/web3.js").VersionedTransactionResponse, // getTransaction() result
  intended: IntendedEffect,                                            // for context (e.g. which mint to look at)
): ActualEffect;
```

- Recipient + amount from **balance deltas**, not from re-reading the instruction args:
  - **SOL:** `confirmedTx.meta.preBalances` / `postBalances` (lamports), indexed against
    `confirmedTx.transaction.message.getAccountKeys()` — the account with the positive delta is the
    recipient; the delta magnitude is the amount.
  - **SPL:** `confirmedTx.meta.preTokenBalances` / `postTokenBalances` (owner, mint, uiTokenAmount).
- **`extraInstructions`** — the important part for the demo's "caught mismatch" beat: enumerate every
  compiled instruction; emit a label for any instruction **not implied by a plain transfer** — a
  `SetAuthority`, an `Approve`/`ApproveChecked`, an added `Transfer`, or any instruction to an
  unknown program. This is what catches "executed, but an extra approval slipped in."
- If you can't parse it (or the module isn't wired yet), return the `unavailable` sentinel — **never a
  fake match** (that footgun is exactly what the design forbids).

### 2. `decodeTransaction` — verify-side (the honesty upgrade for `/verify`)

Derive **ground-truth intent + policy flags** from the **unsigned** tx the caller submits, replacing
today's self-reported args (this closes the "compromised agent omits the flag" gap).

```ts
function decodeTransaction(
  unsignedTxBase64: string, // base64 of a serialized VersionedTransaction (VersionedTransaction.deserialize)
): DecodedIntent;
```

- `actionKind`, `recipient`, native `amount` — same extraction as above but from the *unsigned*
  instructions.
- `flags`:
  - `authority_change` — a Token-program `SetAuthority` (or system `Assign`/nonce authorize).
  - `unlimited_delegate` — an `Approve`/`ApproveChecked` whose amount is u64-max (or effectively
    unbounded).
  - `unknown_program` — any instruction to a programId outside the known set (System, Token,
    Associated-Token, the known DEX programs).
  - `suspicious_recipient` — **leave undefined**; that's a denylist check Lilly's policy layer owns.

---

## Frozen shared types (Lilly lands these at `shared/types/verdictContracts.ts` as the first impl
commit; import from `@shared/verdictContracts`)

```ts
export type IntendedEffect = {
  actionKind: "transfer" | "swap" | "unknown";
  recipient?: string;      // destination pubkey (SOL) or destination token-account owner (SPL)
  lamports?: number;       // SOL transfer amount, native (NOT USD — see "Amount units" below)
  tokenAmount?: string;    // SPL amount in base units, as a string (avoid float precision loss)
  mint?: string;           // SPL mint
  amountUsd?: number;      // only for the policy cap check; NOT used by the confirm compare
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

export type DeriveActualEffect = (tx: import("@solana/web3.js").VersionedTransactionResponse, intended: IntendedEffect) => ActualEffect;
export type DecodeTransaction = (unsignedTxBase64: string) => DecodedIntent;
```

**Amount units — decided: native, not USD.** The confirm compare runs on native units (lamports /
token base units + mint), because comparing on-chain reality in USD would need a price oracle and
would throw false mismatches on rounding/slippage. `amountUsd` stays only for the pre-flight policy
cap. (This refines the design's earlier `amountUsd`-only shape to native for the compare; Lilly is
reconciling that in the tracker — your interface above is final.)

---

## Where it plugs in (you don't touch these — for context only)

Lilly injects your functions; the defaults are safe stubs until yours land:

```ts
createVerifyConfirmService({ verdictStore, getConfirmedTx, deriveActualEffect /* ← yours; default: unavailable */ });
createVerifyService({ /* ... */ decodeTransaction /* ← yours; default: self-reported path */ });
```

Connection for fetching confirmed txs already exists — `getConnection()` in
`back/services/solana/providers/solanaConnection.ts` (commitment `'confirmed'`); Lilly's endpoint
calls `getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })` and hands
you the result. You don't make RPC calls inside `deriveActualEffect` — you receive the fetched tx.

---

## Testing — in isolation, no live RPC

Unit-test both functions against **recorded** `getTransaction` JSON fixtures (snapshot a few real
devnet txs once, commit the JSON, replay in tests). Provide at minimum:

1. A clean SOL transfer → `deriveActualEffect` returns matching recipient+lamports, `extraInstructions: []`.
2. An SPL transfer → matching recipient+tokenAmount+mint.
3. **The seeded-mismatch demo fixture (deliverable):** craft a devnet tx that does a transfer **plus an
   extra `SetAuthority` or `Approve`**, record its `getTransaction` output, and assert
   `deriveActualEffect` surfaces the extra instruction in `extraInstructions`. This JSON fixture is the
   demo's "caught mismatch" asset — Act 2 depends on it.
4. `decodeTransaction` over a base64 unsigned tx with a `SetAuthority` → `flags.authority_change: true`.

---

## Your deliverables checklist

- [ ] `deriveActualEffect(confirmedTx, intended): ActualEffect` — recipient + native amount from balance
      deltas, `extraInstructions` from the instruction set, `unavailable` sentinel on parse failure.
- [ ] `decodeTransaction(unsignedTxBase64): DecodedIntent` — actionKind/recipient/native amount + the
      three flags.
- [ ] The shared instruction-parsing core both reuse (System + SPL-Token instruction recognition).
- [ ] Fixture-based tests, including the **seeded-mismatch** JSON.
- [ ] Match the frozen signatures above exactly — that's the whole integration.

## Coordination

- The shared types land in `shared/types/verdictContracts.ts` (the block above) as the first impl
  commit; until then, paste the block locally so you can start now.
- Integration = your module is imported at the two injection points. No other wiring.
- One open item that does **not** block you: the exact amount-match tolerance used when comparing
  intended vs actual is still being finalized — your job is to report **accurate native amounts**; the
  tolerance is applied downstream.
