# Custody models for on-chain AI agents — NEUTRAL run

*Re-run of the custody-split research with the decision-context framing removed and an explicit anti-bias instruction (surface evidence that cuts against the apparent trend; treat "agents shouldn't hold keys" as advocacy). No execution-guard section.*

**Method:** 5-angle fan-out → 18 sources fetched → 82 claims extracted → 25 adversarially verified (3-vote). This run completed clean: **19 confirmed, 6 killed**, no rate-limit abstentions (vs. the framed run's 12 confirmed / 11 lost to a rate-limit). Evidence quality is materially higher here.

---

## Headline: how the neutral answer differs from the framed one

The framed run leaned toward *"delegation is winning, ~half the market delegates."* The neutral evidence does **not** support that as a present-tense fact. What the verified claims actually show:

- **By framework default and by agent count, holds-own-key (raw local keypair) is the dominant model today** — and on Solana it is *structurally entrenched*.
- **Delegation dominates the commercial/enterprise vendor landscape and the direction of new launches + funding** — but claims of delegation *dominance* are inflated by **directory selection bias** and **vendor advocacy**, both of which the verifier explicitly flagged.

So the honest correction to the framed report: holds-own-key is **stronger today** than the framed version implied; delegation is the **well-funded challenger and trajectory**, not the incumbent majority.

---

## 1. Estimated split (neutral)

No census exists; this is triangulated. The split inverts depending on the denominator:

| Denominator | Holds-own-key | Delegates | Confidence |
|---|---|---|---|
| **Framework default** (what OSS agent frameworks ship) | **Dominant** — eliza core ships *only* holds-own-key; SAK defaults to raw keypair | Opt-in / secondary | **HIGH** (primary code) |
| **Agent count** (full deployed population, retail-heavy) | **Plurality–majority** | Minority but growing | LOW–MEDIUM |
| **Commercial vendor products** (purpose-built agent wallets) | ~0% | **~100%** (all 34–35 delegate) | HIGH, *but selection-biased* |
| **New launches + funding** | Minority | **Dominant** | MEDIUM–HIGH |
| **x402 micropayment volume** | Custody-agnostic — protocol accommodates both; doesn't resolve the split | — | HIGH (that it's agnostic) |

Within **delegation**, the vendor taxonomy is messier than marketing implies (verified): **TEE/secure-enclave** signing (Turnkey, Coinbase CDP) is at least as prominent as **MPC/TSS** — the verifier *killed* a claim that "MPC is the dominant signing model" because Turnkey is explicitly *not* MPC ("Unlike MPC, TEEs do not split keys") and Coinbase CDP is TEE-primary. On-chain **smart-account/program** delegation (4337/7702, Squads PDAs) is real but the smallest agent bucket.

---

## 2. What dominates today, and why (verified)

**Holds-own-key is the framework default — this is the strongest, most concretely-sourced finding in the run:**

- **ElizaOS / ai16z core Solana plugin: holds-own-key is the *only* signing model shipped.** `getWalletKey` reads `SOLANA_PRIVATE_KEY`/`WALLET_PRIVATE_KEY`, decodes base58, and builds the keypair in-process via `Keypair.fromSecretKey`; signs locally with `transaction.sign([keypair])` → `sendTransaction`. A TEE (Phala) path existed but was **opt-in, gated behind `TEE_MODE` (default OFF) — and the latest release (1.2.6) removed the TEE branch entirely.** *(Primary: @elizaos/plugin-solana; verified 3-0.)* That removal is a genuine **counter-trend signal**: the dominant OSS framework went *more* holds-own-key in its newest release.
- **Solana Agent Kit: raw base58 keypair is the documented/canonical onboarding.** *(Primary: github.com/sendaifun/solana-agent-kit; verified 3-0.)*
- **Alchemy's 2026 build tutorial shows both SAK and eliza holding the raw key** (env var → `KeypairWallet` → local signing). *(Verified 3-0 ×2.)*

Why it dominates: it's the lowest-friction path (hand the framework a key, get a signing agent), and it's what the two leading open-source agent frameworks ship by default. The 2024–2025 retail/trading agent wave was built this way.

**Delegation dominates the *commercial vendor* surface — but with caveats the verifier insisted on:**

- **Coinbase AgentKit** brands the model "Every AI Agent deserves a wallet." *(Primary; verified 3-0.)*
- **Coinbase Agentic Wallets** keep keys in Coinbase TEE/enclaves, never exposed to the LLM/prompt — true delegation. Coinbase's "true self-custody" label is **advocacy** (it means non-custodial vs. Coinbase, not agent-held). *(Verified 3-0 ×2.)*
- **agentwallet.md catalogs ~34–35 purpose-built agent-wallet products, all delegated, none agent-held** — but this is a **curated vendor directory; selection bias, not the agent population.** *(Verified 3-0, caveat in the claim itself.)*
- **Turnkey** ($30M raise tied to AI agents) sells embedded wallets eliminating seed phrases. *(Verified 3-0 ×2.)*

---

## 3. Trajectory (12–24 months)

Direction of travel is **toward delegation in the commercial/enterprise layer**, with real counter-signals in OSS:

- **Framework defaults are starting to shift.** SAK **v2** integrates Turnkey + Privy embedded wallets as a built-in and frames v1's raw-key input as a security weakness. *(Verified 3-0; the "designed so the agent doesn't directly receive the raw key" framing verified 2-1.)* This is the single clearest "holds-own-key → delegated" trajectory signal in a dominant framework.
- **Vendor + investor momentum is delegated.** Coinbase Agentic Wallets, Turnkey's agent-tied raise, 34+ purpose-built delegated products, and infra-vendor tutorials (Alchemy) recommending Turnkey/Phala/Crossmint for "production security." *(Verified; the "vendor-advocated" framing explicitly confirmed, 2-1.)*
- **Counter-signal:** eliza core **removed** its TEE delegation branch in its latest release — the most-used OSS framework did *not* move toward delegation in practice. So the shift is **vendor/enterprise-led, not yet OSS-default**.

Net (MEDIUM confidence): new enterprise/payments builds default to delegation; the OSS retail/trading base stays holds-own-key; over 24 months the *new-build* mix tilts delegated as frameworks bundle vendors, but the installed base and Solana's structure keep holds-own-key large.

---

## 4. Solana vs EVM / x402

| | **Solana** | **EVM / x402** |
|---|---|---|
| **Default onboarding** | Raw keypair (SAK, eliza). *Structurally entrenched.* | ERC-4337 smart-contract wallets; EIP-7702 (Pectra, live) brings AA to EOAs. |
| **Native AA?** | **No — myth corrected.** Every Solana tx needs a raw ed25519 fee-payer/signer; **PDAs cannot originate txs or pay fees.** Programmable signing needs a *program layer* (Squads Smart Account Program, Helius smart wallets) — architecturally analogous to 4337, not fundamentally different. | ERC-4337 = the smart-contract-wallet standard; 7702 lets EOAs delegate to contract code. More mature programmable-signing primitives. |
| **PDAs** | *Can* sign for program-controlled actions without a private key (delegated/programmatic) — but only *within* a tx a real keypair already initiated and paid for. *(Verified 3-0.)* | session-key modules (ZeroDev/Biconomy/Safe/Kernel). |
| **Direction** | Delegation arriving top-down via vendors (SAK v2 Turnkey/Privy; Squads program layer), not via protocol. | Delegation is more native; x402 backend model + AA. |

**The key correction (verified, 0-3 kill):** the popular "Solana natively supports account abstraction, Ethereum must retrofit it" claim is **false / vendor marketing**. Both ecosystems need a program/contract layer for programmable signing, and **Solana still requires a raw keypair fee-payer for every transaction** — so holds-own-key is, at minimum, *unavoidable for the fee-payer* on Solana even when a smart wallet is involved.

**x402 is custody-agnostic (verified):** it "requires the agent to be equipped with a wallet OR access to a wallet service" — it accommodates *both* local and delegated signing and therefore **does not resolve the split**. The verifier *killed* a claim that x402 implies local signing (client-constructs-payload ≠ key-held-locally; x402 is signer-agnostic per the CDP FAQ: buyers "sign locally in their runtime" *or* "use CDP Wallet API").

---

## 5. How big is agentic on-chain activity? (volume context)

A claim that "agent payments are 0.0001% of stablecoin volume → agentic transacting is negligible" was **killed (0-3) for overreach**: that figure is **x402-micropayment-specific** and excludes the much larger category of autonomous trading/DeFi agents (DEX swaps, perps) — which are precisely the holds-own-key SAK/eliza agents. x402 itself is small and the numbers are loose/inconsistent (blog-reported ~$28k/day, ~$600M "annualized," ~$50M cumulative by Apr 2026 — internally divergent, **LOW confidence**). Takeaway: **x402 delegated micropayments are tiny; the larger agentic volume sits with trading/DeFi agents that skew holds-own-key.**

---

## Confidence, gaps, caveats

- **HIGH confidence:** framework defaults (eliza, SAK = holds-own-key, primary code); Coinbase Agentic Wallets = TEE delegation; x402 is custody-agnostic; Solana needs a raw keypair fee-payer (PDA-AA myth corrected); the commercial agent-wallet directory is all-delegated.
- **LOW–MEDIUM confidence:** the actual *population* split (no census); all volume figures (loose blog numbers).
- **Selection bias flagged twice:** the all-delegated vendor directory and the all-delegated vendor blogs over-represent delegation relative to the real agent population (which is dominated by OSS raw-keypair frameworks).
- **6 killed claims** (overreach in both directions): "AgentKit ships exactly 3 providers" (it ships 14 across 5 families); "no delegated path in SAK docs" (v2 docs do document Turnkey/Privy); "x402 ⇒ local signing"; "MPC is the dominant model" (Turnkey/Coinbase are TEE, not MPC); "agentic volume negligible overall"; "Solana has native AA without raw keys."

## Sources (verified-tier)

Primary: github.com/elizaos-plugins/plugin-solana (+ npm @elizaos/plugin-solana); github.com/sendaifun/solana-agent-kit; github.com/coinbase/agentkit; docs.sendai.fun/docs/v2; chainalysis.com/blog/x402-agentic-payments-adoption; bundlebear.com/eip7702-overview. Secondary/blog (weighed as advocacy where vendor-authored): coinbase.com Agentic Wallets; theblock.co (Coinbase agent wallet); cointelegraph.com (Turnkey $30M); alchemy.com (2026 Solana agent tutorial); squads.xyz; crossmint.com; helius.dev (Solana smart wallets); eco.com (x402 explainer); ainvest.com (x402 volume, low-confidence); agentwallet.md (vendor directory).

---

*Generated via the deep-research workflow, neutral framing. 18 sources, 82 claims extracted, 25 verified (19 confirmed / 6 killed). 2026-06-30.*
