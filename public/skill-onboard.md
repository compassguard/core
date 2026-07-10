---
name: compass-onboarding
description: Guides a coding agent through helping a user test Compass — the execution firewall for AI agents on Solana. Use when the user asks you to test, try, set up, or demo Compass, or points you at https://compassguard.xyz/skill-onboard.md. Covers minting an API key via POST /signup, the POST /v1/verify decision API, reading allow/deny/review verdicts, and optionally wiring the MCP guard into the user's own agent.
license: MIT
compatibility: Any coding agent with a shell (curl) and, for the optional guard step, the Claude Code CLI + Node.js 18+.
metadata:
  author: Compass
  version: 1.1.0
  homepage: https://compassguard.xyz
---

# Compass Onboarding

## Overview

Compass is an **execution firewall for AI agents on Solana**. Before a mutating Solana action (a
transfer or swap) is signed, Compass checks it against a hosted policy and returns `allow` / `deny` /
`review` with a human-readable reason. It is advisory today — a fast safety check an agent can honor
— and every call is logged to an audit trail.

**You are the coding agent following this skill.** Run the commands *for* the user in their terminal,
read the real output back to them, and explain each verdict. The goal: get the user to a working
Compass integration — first a live decision from the `/v1/verify` API, then (optionally) the guard
wired into their own agent. Work through the Procedure in order.

## When to Use

- The user asks you to **test, try, set up, or demo Compass**, or asks "does this transfer pass the
  guard?"
- The user **points you at `https://compassguard.xyz/skill-onboard.md`**.

**When NOT to use:** building or modifying Compass itself (that's the repo `README.md`), or any task
unrelated to exercising the hosted `/v1/verify` API or MCP guard.

## Base URL

`https://compassguard.xyz` — `/signup` and `/health` are public; everything
under `/v1/*` needs a bearer token.

## Hard rules — do not violate these

1. **Never invent, guess, or hard-code an API key.** A made-up key doesn't fake a verdict — it just
   returns `401`. If the user has no key, **mint one via `POST /signup`** (Step 2) rather than
   fabricating anything.
2. **Only use recognized tool names** in `/v1/verify` (Step 3). An unrecognized mutating `toolName`
   (e.g. `solana_transfer`) is **denied by default** — that `deny` is the fail-closed policy working
   as designed, not a bug or a real threat. Don't alarm the user.
3. **A `401` means the key is missing or wrong**, not that the service is down. `/health` needs no
   auth — use it to prove reachability before blaming the network.
4. **Report real output.** Run each command and show the user the actual JSON. Never fabricate a
   verdict or claim a success you haven't observed.

## Procedure

### Step 1 · Prove the service is reachable (no auth)

```sh
curl -s https://compassguard.xyz/health
```

Expect `{"ok":true,"service":"compass-hosted-guard","dependencies":{...}}`. If you get this, the
service is live; if not, stop and troubleshoot connectivity with the user first.

### Step 2 · Get a token

**Default path — self-serve signup (no auth, works for the "I have no key" case):** mint an
email-scoped API key for the user. Confirm the email with them first, then:

```sh
curl -sX POST https://compassguard.xyz/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"<their-email>"}'
# → {"email":"<their-email>","apiKey":"compass_…"}

export COMPASS_HOSTED_API_KEY='compass_…'   # the apiKey from the response
```

That `compass_…` key is the bearer token for Step 3. Verdicts made with it are **attributed to the
user's email**, and it can be revoked independently. Signup is open (any well-formed email, no
verification), so this is the honest way to satisfy "just show me a verdict" — no fabricating.

Other paths, if they apply:

- **Shared key:** the user may already have a shared `COMPASS_HOSTED_API_KEY` (e.g. the one the MCP
  proxy uses); it works the same way. If they want the shared key, point them to
  **[@Satoshi0101](https://t.me/Satoshi0101) on Telegram**.
- **Local backend they run:** signup mints keys against their instance, or they set a shared
  `COMPASS_HOSTED_API_KEY` (any string) identically on server and client:
  ```sh
  export COMPASS_HOSTED_API_KEY='dev-local-key'
  npm run hosted:dev          # requires Bun (runs `bun hosted/server.ts`); long-running —
                              # start it in the BACKGROUND; guard listens on :3001
  # then use http://localhost:3001 as the base URL instead of the hosted one
  ```

If no key is available, **stop here** and tell the user you need one — do not attempt authenticated
calls.

### Step 3 · Get the user their first verdict — `POST /v1/verify`

The payoff. Send an *intended* tool call and read back the decision. No on-chain state or signing is
involved — the decision runs on `toolName`, `intent`, and `arguments`.

Recognized `toolName` values (anything else mutating → denied by default): `transfer`,
`transfer_sol`, `guarded_transfer`, `swap`, `orca_swap`, `conditional_buy_sol`. `intent.kind` is
`"transfer"` or `"swap"` and selects the policy path.

**What the three decisions mean — set expectations before the user sees one.** Compass is advisory,
so it never signs; it returns a *recommendation*:

- **`allow`** — within policy; safe to execute.
- **`review`** — **held for human approval; the agent should not auto-sign it.** This is what a
  "blocked" bad transfer looks like in the advisory tier — an unknown recipient or an over-cap amount
  returns `review`, not `deny`. If the user asks to "see a transfer get blocked," a `review` verdict
  *is* that block; say so plainly.
- **`deny`** — a hard refusal, mainly from fail-closed cases: an unrecognized `toolName`, a
  denylisted recipient, or an `authority_change` / `unlimited_delegate` flag. Explain it; don't
  present a `deny`-on-unknown-tool as a judgment about the transfer's merits.

**3a — unknown recipient → `review`:**

```sh
curl -sX POST https://compassguard.xyz/v1/verify \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "transfer",
    "intent": { "kind": "transfer" },
    "arguments": { "recipient": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "amountUsd": 5, "recipientKnown": false }
  }'
```

Expected:

```json
{
  "correlationId": "…",
  "decision": "review",
  "riskLevel": "medium",
  "reasons": ["TRANSFER_UNKNOWN_RECIPIENT"],
  "humanExplanation": "Recipient is not on the allowlist."
}
```

**3b — known recipient under the cap → `allow`:** flip `recipientKnown` to `true` (keep `amountUsd`
at or below the default **$10** approval-free cap) → `decision: "allow"`, reasons
`["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"]`. Raising `amountUsd` above the cap flips it back to
`review` with `TRANSFER_EXCEEDS_LIMIT`.

Keep a `correlationId` if the user wants the optional confirm step (Step 5).

### Step 4 · (Optional) Wire the guard into the user's agent

If the user runs a Solana MCP server through Claude Code and wants Compass to guard it
automatically, register the proxy — it wraps one downstream MCP server and checks every tool call
flowing through it:

```sh
claude mcp add compass \
  --env COMPASS_HYBRID_GUARD_ENABLED=true \
  --env COMPASS_HOSTED_API_URL=https://compassguard.xyz \
  --env COMPASS_HOSTED_API_KEY=$COMPASS_HOSTED_API_KEY \
  -- npx -y @ramadan04/compass-mcp-guard \
     --downstream-name solana-tools \
     --downstream-command npx \
     --downstream-args-json '["@their-downstream/mcp-server"]'
```

Replace `@their-downstream/mcp-server` with the user's actual Solana MCP server, then confirm with
`claude mcp list` (→ `compass ✓`).

### Step 5 · (Optional) Confirm the outcome after a tx lands — `POST /v1/verify/confirm`

If the user executed a transaction they verified, close the loop with the `correlationId` from
Step 3 and the on-chain signature:

```sh
curl -sX POST https://compassguard.xyz/v1/verify/confirm \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "correlationId": "<from-step-3>", "txSignature": "<solana-tx-signature>" }'
```

**Set expectations honestly:** the on-chain effect decoder is still landing, so on the current
hosted deploy a valid confirmed tx returns `{"outcome":"unverified_no_decoder"}` rather than
`match`/`mismatch`. That is intentional — Compass returns a sentinel instead of fabricating a match.
`POST /v1/verify` (Step 3) is the fully-live piece.

## Quick Reference

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness — `{"ok":true,…}` |
| `POST /signup` | none | Mint an email-scoped API key → `{email, apiKey}` |
| `POST /v1/verify` | Bearer | Decision on an intended tool call → `allow`/`deny`/`review` |
| `POST /v1/verify/confirm` | Bearer | Optional phase-2 outcome check by `correlationId` + `txSignature` |

| Decision | Risk | Means |
|---|---|---|
| `allow` | `low` | Within policy — safe to execute |
| `review` | `medium` | Held for human approval — the advisory "block" |
| `deny` | `high` | Hard refusal — fail-closed (unknown tool, denylist, authority/delegate flag) |

Recognized `toolName`: `transfer`, `transfer_sol`, `guarded_transfer`, `swap`, `orca_swap`,
`conditional_buy_sol`.

## Common Mistakes

- **Using `solana_transfer` (or any unlisted name)** and reporting the resulting `deny` as a caught
  threat. It's fail-closed on an unknown tool. Use a recognized name.
- **`amountUsd` above the $10 default cap** while trying to demo an `allow` — it returns `review`
  (`TRANSFER_EXCEEDS_LIMIT`). Keep the amount ≤ 10 for the allow case.
- **Omitting `recipientKnown`** — the allowlist check can't run and you get `TRANSFER_MISSING_RECIPIENT`
  instead of the intended `TRANSFER_UNKNOWN_RECIPIENT`. Pass `recipientKnown: true|false` explicitly.
- **Calling a `review` "not blocked."** In the advisory tier, `review` *is* the block (hold for
  approval).
- **Reading a `401` as an outage.** It means the key is missing or wrong; `/health` proves the
  service is up.

## You're Done When

- `/health` returned `{"ok":true,…}` (Step 1), **and**
- the user saw at least one real verdict from `/v1/verify` — ideally both a `review` (3a) and an
  `allow` (3b) — with you explaining what drove each decision.

Wiring the MCP guard (Step 4) and confirm (Step 5) are optional next steps, not required for success.

**Human dev quickstart:** `https://compassguard.xyz/quickstart.md`.
