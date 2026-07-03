# Wave 8 — Demo hardening technical spec

Wave 8 is documentation and verification hardening around the already implemented MCP Guard server. It should not introduce a new execution path. The primary artifact is an executable runbook with captured evidence.

## Architecture

```txt
Reviewer
  -> Wave 8 runbook
    -> Compass MCP handlers/server
      -> list tools
      -> call read/preparation tool
      -> call guarded transfer tool
      -> call denied signing/prompt-injection style tool
      -> inspect redacted result and audit examples
```

The demo proves the product story: Compass controls execution. It does not merely provide chat suggestions.

## Files

| File | Role |
| --- | --- |
| `docs/wave-8-demo-hardening/runbook.md` | Reviewer-facing local demo steps and captured evidence. |
| `docs/wave-8-demo-hardening/functional-spec.md` | Functional acceptance requirements for the demo hardening wave. |
| `docs/wave-8-demo-hardening/technical-spec.md` | Technical approach and verification commands. |
| `docs/wave-8-demo-hardening/task.json` | Task plan and validation checklist. |
| `docs/README.md` | Index link for Wave 8 docs. |

## Demo Outcomes

| Outcome | Tool | Expected decision | Purpose |
| --- | --- | --- | --- |
| Safe preparation | `get_usdc_sol_quote` | `ALLOW` | Shows low-risk preparation can proceed. |
| Risky execution | `guarded_transfer_sol` | `REQUIRE_HUMAN_APPROVAL` | Shows Compass requires approval before sensitive execution. |
| Unsafe signing | `sign_and_send_transaction` | `DENY` | Shows raw signing cannot bypass guardrails. |

## Audit Evidence

Audit examples should use the in-process MCP audit sink so the runbook can capture deterministic local examples without external storage. Examples must be redacted and must not include raw transaction bytes, private keys, prompts, or secret material.

## Network Statement

Wave 8 docs must distinguish these states:

| Network/path | MVP status |
| --- | --- |
| Local MCP server | Supported for local demo. |
| Devnet/testnet/custom non-mainnet RPC | Acceptable for controlled local signer demos when explicitly configured. |
| Mainnet local signer | Blocked for MVP. |
| Production custody | Out of scope. |

## Verification

- Execute the Wave 8 runbook command from `docs/wave-8-demo-hardening/runbook.md`.
- `npm run test:back`
- `npm run lint`
- `npx tsc --noEmit --pretty false`
- `npm run build` only if routes or Next config change.
