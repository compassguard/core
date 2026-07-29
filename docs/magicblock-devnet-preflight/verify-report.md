# MagicBlock Devnet On-Chain Audit Verification Report

Date: 2026-07-29

## Deterministic verification

`npm run preflight:magicblock-devnet` passes the dependency-closure gate and the
focused unit, route, Postgres, observer, submission, verification, and E2E
suite. The closure keeps MagicBlock audit code isolated from authorization,
execution, wallet signing, and transaction sending boundaries while permitting
only the dedicated audit path.

The E2E crosses:

```text
MCP SDK request
-> dispatcher and controlled downstream result
-> awaited hosted audit client
-> authenticated ingress
-> trusted transaction decode and MagicBlock evidence
-> PGlite canonical ledger
-> injected signed-submission seam
-> durable on-chain record
-> GET by audit ID and signature
-> independent verification result
```

It proves a Compass result exposes confirmed proof only after registration and
that wrong authentication yields an explicit retryable state without
persistence. Unit tests separately prove deterministic signing, exact Memo
contents, confirmation polling, compiled instruction decoding, required audit
signer validation, signer file loading, retryable prepared signatures, and
privacy exclusions.

## Repository verification

- `npm run preflight:magicblock-devnet`: pass, 8 files / 201 tests.
- `npm test`: pass, 60 files / 732 tests; 2 live suites / 22 tests skipped.
- `npm run lint`: pass.
- `npm run build`: pass.
- `npm run build:mcp`: pass.
- `node --check scripts/verify-magicblock-preflight-dependency-closure.mjs`:
  pass.
- `npx tsc --noEmit --pretty false`: blocked only by the pre-existing unrelated
  test import `back/services/__tests__/mcpProxyDispatcher.test.ts` ->
  `../mcp/mcpProxyContracts`.

## Live proof

No dedicated funded devnet audit credential was available to this worker.
Accordingly, no live signature or explorer URL is claimed. The exact
credential formats and `npm run smoke:magicblock-devnet-onchain` command are
documented in `technical-spec.md` and the implementation report.
