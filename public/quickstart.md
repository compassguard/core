# Compass — Dev Quickstart

Compass is an **execution firewall for AI agents on Solana**. It sits in front of your agent's
Solana tools and checks every mutating action against a hosted policy *before* it runs — returning
`allow` / `deny` / `review` with a human-readable reason.

Two ways to use it:

1. **Drop it into your MCP client** — the guard proxies your existing Solana MCP server and checks
   every tool call flowing through it. Zero code changes to your agent.
2. **Call `POST /v1/verify` directly** — for x402 partners, custom backends, or a raw HTTP integration.

> New to the repo / setting up from source? See the top-level `README.md`. **This** page is the
> 60-second dev quickstart against the hosted API.

**Base URL:** `https://compassguard.xyz` — signup, health, verify, and confirm are all served here.

```sh
curl https://compassguard.xyz/health
# {"ok":true,"service":"compass-hosted-guard","dependencies":{...}}   (no auth required)
```

---

## 1 · Get a token

The fastest path is **self-serve signup** — no auth required, mints an email-scoped API key:

```sh
curl -sX POST https://compassguard.xyz/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
# → {"email":"you@example.com","apiKey":"compass_…"}

export COMPASS_HOSTED_API_KEY='compass_…'   # the apiKey from the response
```

That `compass_…` key is your bearer token for every `/v1/*` call below. Verdicts you make with it are
**attributed to your email**, and it can be revoked independently — a revoked key returns `401` on its
next request.

Other paths:

- **Shared key:** a single `COMPASS_HOSTED_API_KEY` also gates `/v1/*` (this is what the MCP proxy
  uses). Message **[@Satoshi0101](https://t.me/Satoshi0101) on Telegram** if you need the shared key
  rather than your own.
- **Local backend:** run it yourself — signup mints keys against your instance, or set a shared
  `COMPASS_HOSTED_API_KEY` (any string) on both server and client:
  ```sh
  export COMPASS_HOSTED_API_KEY=dev-local-key
  npm run hosted:dev          # starts the guard on http://localhost:3001
  ```

The server **fails closed**: a wrong/missing bearer token → every `/v1/*` request is `401`.
(`/signup` and `/health` stay open.)

---

## 2 · Add the guard to Claude

The guard is a **proxy** — it wraps one downstream MCP server and guards the tool calls flowing
through it. Register it with the Claude Code CLI:

```sh
claude mcp add compass \
  --env COMPASS_HYBRID_GUARD_ENABLED=true \
  --env COMPASS_HOSTED_API_URL=https://compassguard.xyz \
  --env COMPASS_HOSTED_API_KEY=$COMPASS_HOSTED_API_KEY \
  -- npx -y @ramadan04/compass-mcp-guard \
     --downstream-name solana-tools \
     --downstream-command npx \
     --downstream-args-json '["@your-downstream/mcp-server"]'
```

Replace `@your-downstream/mcp-server` with the Solana MCP server you want protected. Then verify the
wiring:

```sh
claude mcp list          # → compass ✓
```

Now every `transfer` / `swap` your agent attempts is checked before it executes.

---

## 3 · Try it — `POST /v1/verify`

Ask for a verdict on a tool call. No decoder or on-chain state needed — the decision runs on the
call's `toolName`, declared `intent`, and `arguments`.

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

Response — an unknown recipient trips human review:

```json
{
  "correlationId": "4a6f1004-…",
  "decision": "review",
  "riskLevel": "medium",
  "reasons": ["TRANSFER_UNKNOWN_RECIPIENT"],
  "humanExplanation": "Recipient is not on the allowlist."
}
```

`decision` is one of **`allow`** / **`deny`** / **`review`**. Two things drive the verdict, so mind them:

- **`toolName` must be a recognized action** — `transfer`, `transfer_sol`, `guarded_transfer`, `swap`,
  `orca_swap`, `conditional_buy_sol`. An unrecognized mutating tool name is **denied by default**
  (`UNKNOWN_MUTATING_TOOL_DENIED`) — that's the fail-closed stance, not a misconfiguration.
- **`intent.kind`** (`"transfer"` or `"swap"`) selects the policy path; `recipientKnown` tells the
  allowlist check whether the destination is trusted. Flip it to `true` (with `amountUsd` under the
  default $10 cap) and the same call returns `allow` / `TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT`.

Keep the `correlationId` — after the tx lands you can confirm the executed effect matched the intent
(phase 2, optional):

```sh
curl -sX POST https://compassguard.xyz/v1/verify/confirm \
  -H "Authorization: Bearer $COMPASS_HOSTED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "correlationId": "4a6f1004-…", "txSignature": "<solana-tx-signature>" }'
# → { "correlationId": "…", "outcome": "match" | "mismatch" | "unconfirmed" | …, "discrepancies": [] }
```

> **Note on `/verify/confirm` today:** the on-chain effect decoder is still landing, so on the
> current hosted deploy a valid confirmed tx returns `outcome: "unverified_no_decoder"` rather than
> `match`/`mismatch`. That's intentional — Compass returns a sentinel instead of fabricating a match.
> `POST /v1/verify` (the decision) is fully live and delivers value on its own; confirm is an opt-in
> second step.

---

## Reference

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness — `{"ok":true,…}` |
| `POST /signup` | none | Mint an email-scoped API key → `{email, apiKey}` |
| `POST /v1/verify` | Bearer | Decision on an intended tool call → `allow`/`deny`/`review` |
| `POST /v1/verify/confirm` | Bearer | Optional phase-2 outcome check by `correlationId` + `txSignature` |

- **npm package:** [`@ramadan04/compass-mcp-guard`](https://www.npmjs.com/package/@ramadan04/compass-mcp-guard)
- **API-testing collection:** `docs/hosted-api/compass-hosted.postman_collection.json`
- **Agent onboarding skill:** point your coding agent at `https://compassguard.xyz/skill-onboard.md`
