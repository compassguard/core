# Routed Guardrail Pipeline Technical Spec

## Purpose

This design restructures backend files so Compass MCP Guard's intended boundaries are readable without changing behavior. The first move is import-only and path-only: current MCP entrypoints, tests, scripts, policy results, approval behavior, audit behavior, signer behavior, transaction builders, providers, and legacy isolation must remain stable.

## Technical Approach

Move flat `back/services/*` modules into boundary folders that match the future routed guardrail pipeline. The restructure must not connect the MCP proxy to transfer or swap gateways yet. Existing exports remain behavior-compatible; if needed, temporary barrel files may preserve old internal import paths during phased migration, but no new public runtime API is introduced.

Current behavior stays:

```txt
MCP client -> back/services/mcp/mcpServer.ts -> mcpProxyDispatcher
  -> mcpProxyPolicyInterceptor -> downstream MCP server

Transfer/swap/conditional tests and callers -> gateway modules directly
  -> executionGateway classification/candidate/audit helpers -> policy engine
```

Target readability becomes:

```txt
MCP boundary/proxy -> deterministic pre-routing -> LLM router -> domain gateway handoff
  -> policy/evidence -> LLM decision stage -> approval/audit/signer/execution support

Transaction builders/providers stay below domain/support layers
```

## Target Folder Map

```txt
back/services/
├── mcp/
│   ├── server/                  # MCP stdio server entrypoint and handler adapters
│   ├── proxy/                   # downstream client, dispatcher, proxy contracts, audit, wrapping
│   └── config/                  # MCP runtime config and repo env loading
├── guardrail/
│   ├── execution/               # generic classification, candidates, audit event construction
│   ├── router/                  # deterministic pre-routing: schema, risk prefilter, obvious denies
│   └── policy/                  # default policy, schema, loader, evaluator
├── domains/
│   ├── transfer/                # transfer gateway, contracts, audit log, wallet safety
│   ├── swap/                    # swap gateway and contracts
│   └── conditional-parking-lot/ # conditional gateway isolated as deprecation candidate
├── intelligence/
│   ├── llm-router/              # future scaffold only; no files yet
│   └── llm-decision/            # advisory operation decision stage, sanitizer, contracts
├── support/
│   ├── approval/                # on-chain approval/readiness verification
│   └── signer/                  # signer adapter and contracts
└── solana/
    ├── transactions/            # transaction payload builders and payload types
    ├── providers/               # connection, network config, quote facade
    └── price-providers/         # provider-specific quote implementation
```

Anchor programs remain in `back/solana/*`; only TypeScript service files move.

## File Movement Plan

| Current file(s) | Target folder | Notes |
|---|---|---|
| `mcp/mcpServer.ts`, `mcp/mcpProxyServerContracts.ts` | `mcp/server/` | Keep `npm run mcp:dev` working by updating script or keeping a compatibility shim at old path during the same phase. |
| `mcp/mcpProxyDispatcher.ts`, `mcp/mcpProxyContracts.ts`, `mcp/downstreamMcpStdioClient.ts`, `mcp/mcpProxyPolicyInterceptor.ts`, `mcp/mcpProxyAudit.ts`, `mcp/mcpAuditSink.ts`, `mcp/mcpConfigWrapping.ts` | `mcp/proxy/` | Preserve current proxy behavior; do not call domain gateways. |
| `mcp/mcpRuntimeConfig.ts`, `mcp/loadRepoEnv.ts` | `mcp/config/` | Runtime config only. |
| `executionGateway.ts`, `executionGatewayContracts.ts` | `guardrail/execution/` | Keep generic classifier/candidate/audit helpers together. |
| `policy/*` | `guardrail/policy/` | Folder move only; no policy YAML or evaluator changes. |
| `transferGateway*`, `transferAuditLog.ts`, `walletSafetyValidation.ts` | `domains/transfer/` | Transfer domain owns its gateway, contracts, audit sink, wallet evidence. |
| `swapGateway*` | `domains/swap/` | Swap domain owns gateway/contracts only. |
| `conditionalGateway*` | `domains/conditional-parking-lot/` | Mark as isolated/deprecation candidate; do not delete in first move. |
| No current files | `intelligence/llm-router/` | Placeholder boundary only; future scaffold for transfer/swap/skip/unknown classification. |
| `llmDecision*`, `llmDecisionSanitizer.ts` | `intelligence/llm-decision/` | Operation decision stage after deterministic evidence and domain policy. |
| `onchainApproval.ts` | `support/approval/` | Approval/readiness verification support. |
| `signerAdapter*` | `support/signer/` | Signer boundary remains default-off/local-dev guarded. |
| `transferTransactionPayload*`, `transactionPayloadTypes.ts` | `solana/transactions/` | Builders/types only; no signing. |
| `solanaConnection.ts`, `solanaNetworkConfig.ts`, `priceQuote.ts`, `priceProviders/*` | `solana/providers/`, `solana/price-providers/` | Keep provider facade separate from domain policy. |

## Migration Phases

Each phase should aim to stay under 400 changed lines by moving a small cluster and updating imports/tests in the same work unit. Estimates below count current file sizes plus expected import/test path edits, so rename detection may make the final diff smaller.

| Phase | Move | Estimated Δ lines | Budget note |
|---|---|---:|---|
| 1 | Move MCP internals into `mcp/server`, `mcp/proxy`, and `mcp/config`. Preserve `npm run mcp:dev` and MCP tests. | ≈1,926 moved + 70-120 import/script/test edits | Likely over 400; split server, proxy, and config or keep temporary old-path re-export shims. |
| 2 | Move generic execution helpers and `policy/*` under `guardrail/`. Update domain/proxy imports only. | ≈1,214 moved + 40-80 import/test edits | Likely over 400; split execution from policy or use short-lived shims. |
| 3 | Move transfer and swap modules under `domains/transfer` and `domains/swap`. Keep gateway function names and contracts unchanged. | ≈1,802 moved + 50-90 import/test edits | Likely over 400; split transfer from swap, with transfer wallet-safety as its own step if needed. |
| 4 | Move LLM decision files under `intelligence/llm-decision`. Keep `intelligence/llm-router/` as an empty future scaffold. | ≈663 moved + 30-60 import/test edits | Likely over 400; move adapter/contracts and sanitizer separately if review budget is strict. |
| 5 | Move approval, signer, transaction builders, and providers under `support/` and `solana/`. | ≈1,284 moved + 50-100 import/test edits | Likely over 400; split approval/signer from transactions/providers or use temporary shims. |
| 6 | Move conditional gateway files to `domains/conditional-parking-lot` with docs/tests updated to reflect isolation, not deletion. | ≈314 moved + 15-30 import/test edits | Near budget; keep as one small phase if rename detection is reliable. |

## Import Strategy

- Prefer direct relative imports inside each boundary at first; do not add path aliases during this restructure.
- Keep contracts separate from behavior after every move (`*Contracts.ts`, `*Types.ts`, `*Schema.ts`).
- Update tests with the moved paths in the same phase as the files they cover.
- If a phase would exceed review budget, add temporary compatibility re-export shims at old paths, then remove them in a later cleanup phase.
- Active code must not import from `legacy/` before or after the restructure.
- The MCP proxy must not import transfer/swap gateways in this change; route-to-domain handoff remains future work.

## Verification Commands

Run after each phase:

```bash
npm run lint
npm run test:back
npx tsc --noEmit
npm run mcp:dev
```

For `npm run mcp:dev`, verify the server still starts from the configured entrypoint and still proxies downstream tools through the existing interceptor path. If the command requires downstream configuration, document the missing env/config result instead of changing behavior.

## Non-Goals

- No routed transfer/swap enforcement.
- No LLM router implementation; `intelligence/llm-router/` is a future scaffold with no files to move in this change.
- No LLM decision implementation; move existing operation-decision files only.
- No router-to-domain handoff implementation.
- No policy, YAML, approval, audit, signer, payload, provider, or MCP protocol behavior changes.
- No deletion of conditional gateway code in the first move.
- No OpenSpec artifacts.
- No imports from `legacy/`.

## Risks

| Risk | Mitigation |
|---|---|
| MCP entrypoint breaks after moving `mcpServer.ts`. | Update `package.json` script or keep a thin old-path shim in the same phase; verify with `npm run mcp:dev`. |
| Import churn exceeds review budget. | Move one boundary per phase and use temporary re-export shims only when necessary. |
| Behavior changes accidentally during moves. | No logic edits; require lint, typecheck, and current backend tests after every phase. |
| Router and LLM decision concepts blur. | Router folder may contain future contracts/placeholders only; LLM operation decision stays under `intelligence/llm-decision`. |
| Conditional code looks active in the new direction. | Move to `domains/conditional-parking-lot` and label as deprecation candidate while preserving tests. |
| Legacy isolation regresses. | Keep lint scope on `app back/services`; scan active imports for `legacy/` during review. |
