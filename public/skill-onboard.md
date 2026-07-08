# Compass Onboarding Skill (for a coding agent)

**You are a coding agent. A user has pointed you at this page to help them test Compass.** Follow
the steps below in order, run the commands *for* the user in their terminal, read the real output
back to them, and explain each verdict. Your goal: get the user to a working Compass integration —
first a live decision from the API, then (optionally) the guard wired into their own agent.

**What Compass is** (so you can explain it): an *execution firewall for AI agents on Solana*. Before
a mutating Solana action (a transfer or swap) is signed, Compass checks it against a hosted policy
and returns `allow` / `deny` / `review` with a human-readable reason. It is advisory today — a fast
safety check an agent can honor — and every call is logged to an audit trail.

**Base URL:** `https://www.compassguard.xyz` (the apex `compassguard.xyz` 308-redirects here; use the
`www` host in commands so POSTs don't trip on the redirect).

---

## Hard rules — do not violate these

1. **Never invent, guess, or hard-code an API key.** The key is a shared bearer secret. If the user
   hasn't given you one and hasn't set `COMPASS_HOSTED_API_KEY`, **STOP and ask them for it** (see
   Step 2). Do not proceed to authenticated calls without a real key.
2. **Only use recognized tool names** in `/v1/verify` (see Step 3). An unrecognized mutating
   `toolName` is **denied by default** — a `deny` you see after using e.g. `solana_transfer` is the
   fail-closed policy working as designed, *not* a bug or a real threat. Don't alarm the user.
3. **A `401` means the key is missing or wrong**, not that the service is down. `/health` needs no
   auth — use it to prove reachability before blaming the network.
4. **Report real output.** Run each command and show the user the actual JSON. Never fabricate a
   verdict or claim success you haven't observed.

---

## Step 1 · Prove the service is reachable (no auth)

```sh
curl -s https://www.compassguard.xyz/health
```

Expect: `{"ok":true,"service":"compass-hosted-guard","dependencies":{...}}`. If you get this, the
service is live. If not, stop and troubleshoot connectivity with the user before going further.

## Step 2 · Get the API key from the user

`COMPASS_HOSTED_API_KEY` is a **shared bearer secret** — there is no signup endpoint. Ask the user
which applies:

- **Testing against the hosted API:** they must get the key from the Compass deploy owner. Ask them
  to paste it, then set it in the shell you're driving:
  ```sh
  export COMPASS_HOSTED_API_KEY='<the-key-they-gave-you>'
  ```
- **Testing a local backend they run:** the key is *any string they choose*, set identically on the
  server and the client:
  ```sh
  export COMPASS_HOSTED_API_KEY='dev-local-key'
  npm run hosted:dev          # long-running — start it in the BACKGROUND; guard listens on :3001
  # then use http://localhost:3001 as the base URL instead of the hosted one
  ```
  Local dev mode is also the honest way to satisfy a "just show me a verdict, I have no key" request:
  the throwaway key is only ever sent to `localhost`, never to the hosted endpoint. Do **not** send a
  made-up key to `https://www.compassguard.xyz` — it will just `401`.

If no key is available, **stop here** and tell the user you need one to continue — do not attempt
authenticated calls.

## Step 3 · Get the user their first verdict — `POST /v1/verify`

This is the payoff. Send an *intended* tool call and read back the decision. No on-chain state or
signing is involved — the decision runs on `toolName`, `intent`, and `arguments`.

**Recognized `toolName` values** (anything else mutating → denied by default):
`transfer`, `transfer_sol`, `guarded_transfer`, `swap`, `orca_swap`, `conditional_buy_sol`.
**`intent.kind`** is `"transfer"` or `"swap"` and selects the policy path.

**What the three decisions mean — set the user's expectations before they see one.** Compass is
advisory today, so it never signs; it returns a *recommendation*:

- **`allow`** — within policy; safe to execute.
- **`review`** — **held for human approval; the agent should not auto-sign it.** This is what a
  "blocked" *bad transfer* looks like in the advisory tier — an unknown recipient or an over-cap
  amount returns `review`, not `deny`. If the user asks to "see a transfer get blocked," a `review`
  verdict *is* that block; say so plainly.
- **`deny`** — a hard refusal. On this deploy you'll mainly see it from fail-closed cases:
  an unrecognized `toolName`, a denylisted recipient, or an `authority_change`/`unlimited_delegate`
  flag. A `deny` from an unrecognized tool name is the policy working as designed — explain it, don't
  alarm the user, and don't present it as a verdict about the transfer's merits.

**3a — a transfer to an unknown recipient → `review`:**

```sh
curl -sX POST https://www.compassguard.xyz/v1/verify \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "transfer",
    "intent": { "kind": "transfer" },
    "arguments": { "recipient": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "amountUsd": 5, "recipientKnown": false }
  }'
```

Expected response:

```json
{
  "correlationId": "…",
  "decision": "review",
  "riskLevel": "medium",
  "reasons": ["TRANSFER_UNKNOWN_RECIPIENT"],
  "humanExplanation": "Recipient is not on the allowlist."
}
```

**3b — the same call to a *known* recipient under the cap → `allow`:** flip `recipientKnown` to
`true` (keep `amountUsd` at or below the default **$10** approval-free cap).

```sh
curl -sX POST https://www.compassguard.xyz/v1/verify \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "transfer",
    "intent": { "kind": "transfer" },
    "arguments": { "recipient": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "amountUsd": 5, "recipientKnown": true }
  }'
# → decision: "allow", reasons: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"]
```

Explain to the user: `decision` is `allow` / `deny` / `review`; `riskLevel` is `low` / `medium` /
`high`; `reasons` are machine codes and `humanExplanation` is the sentence to show a person. Raising
`amountUsd` above the cap flips it to `review` with `TRANSFER_EXCEEDS_LIMIT`. **Keep a
`correlationId`** if the user wants to try the optional confirm step (Step 5).

## Step 4 · (Optional) Wire the guard into the user's agent

If the user runs a Solana MCP server through Claude Code and wants Compass to guard it
automatically, register the proxy. It wraps one downstream MCP server and checks every tool call
flowing through it:

```sh
claude mcp add compass \
  --env COMPASS_HYBRID_GUARD_ENABLED=true \
  --env COMPASS_HOSTED_API_URL=https://www.compassguard.xyz \
  --env COMPASS_HOSTED_API_KEY=$COMPASS_HOSTED_API_KEY \
  -- npx -y @ramadan04/compass-mcp-guard \
     --downstream-name solana-tools \
     --downstream-command npx \
     --downstream-args-json '["@their-downstream/mcp-server"]'
```

Replace `@their-downstream/mcp-server` with the user's actual Solana MCP server. Then confirm:

```sh
claude mcp list          # → compass ✓
```

## Step 5 · (Optional) Confirm the outcome after a tx lands — `POST /v1/verify/confirm`

If the user executed a transaction they verified, close the loop with the `correlationId` from
Step 3 and the on-chain signature:

```sh
curl -sX POST https://www.compassguard.xyz/v1/verify/confirm \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "correlationId": "<from-step-3>", "txSignature": "<solana-tx-signature>" }'
```

**Set expectations honestly:** the on-chain effect decoder is still landing, so on the current
hosted deploy a valid confirmed tx returns `{"outcome":"unverified_no_decoder"}` rather than
`match`/`mismatch`. That is intentional — Compass returns a sentinel instead of fabricating a match.
Tell the user this is expected today; `POST /v1/verify` (Step 3) is the fully-live piece.

---

## You're done when

- `/health` returned `{"ok":true,…}` (Step 1), **and**
- the user saw at least one real verdict from `/v1/verify` — ideally both a `review` (3a) and an
  `allow` (3b) — with you explaining what drove each decision.

Wiring the MCP guard (Step 4) and confirm (Step 5) are optional next steps, not required to call the
test a success.

**More detail:** the human dev quickstart is at `https://compassguard.xyz/quickstart.md`.
