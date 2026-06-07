# `back/`

Backend del **Compass MCP Guard**: servicios, contratos, policy engine, transfer guard, audit log y programas Anchor.

## Layout

```txt
back/
├── services/
│   ├── executionGateway.ts            # Wave 1: classifyToolCall, createActionCandidate, buildAuditEvent
│   ├── executionGatewayContracts.ts   # tipos canonicales del gateway
│   ├── policy/
│   │   ├── defaultPolicy.yaml         # política MVP conservadora
│   │   ├── loadPolicy.ts              # parser y cache YAML
│   │   ├── policyEngine.ts            # evaluador puro
│   │   ├── policyContracts.ts         # tipos
│   │   ├── policyEvaluationResult.ts  # helpers de outcomes
│   │   └── policySchema.ts            # validación
│   ├── transferGateway.ts             # Wave 3: evaluate/verify/audit del transfer guard
│   ├── transferGatewayContracts.ts    # tipos del transfer guard
│   ├── transferAuditLog.ts            # sink in-memory bounded
│   ├── walletSafetyValidation.ts      # safety primitives
│   ├── onchainApproval.ts             # verificación contra agent-action-guard program
│   ├── priceQuote.ts                  # USD context para policy
│   ├── priceProviders/
│   │   └── orcaUsdcSol.ts             # quote devnet USDC/SOL para priceQuote
│   ├── solanaConnection.ts            # conexión RPC centralizada
│   ├── solanaNetworkConfig.ts         # constantes de red, mints
│   ├── envHttp.ts                     # getEnv, jsonResponse, passthrough
│   └── __tests__/                     # tests de Vitest backend
└── solana/
    ├── agent-action-guard/            # Anchor program: políticas, approvals, attestations
    └── conditional-escrow-buy/        # Anchor program: conditional buy oracle-triggered
```

## Reglas

1. **Nada de `back/` puede importar de `legacy/`.** ESLint enforza esto con `no-restricted-imports`. Si necesitás algo que vive en legacy, refactorealo en el árbol nuevo.
2. **Types separados del comportamiento.** Tipos canonicos, interfaces y constantes viven en `*Contracts.ts` (o equivalente). El comportamiento importa los tipos desde ahí.
3. **Critical operations pasan por guardrails.** Cualquier acción mutante (transfer, swap futuro, conditional futuro) tiene que pasar por gateway/policy antes de construir tx no firmada.
4. **No raw transactions ni prompts en audit metadata.** El sink usa `buildAuditEvent` que tiene redaction; cualquier campo freeform debe pasar por sanitización o ser omitido.

## Variables de entorno

Ver `back/.env.example`. Mínimo para el MCP Guard hoy:

- `AGENT_ACTION_GUARD_PROGRAM_ID`: program ID del agent-action-guard deployado.
- `SOLANA_RPC_URL`: endpoint RPC para Solana (devnet por default).
- `WALLET_SAFETY_ATTESTOR_SECRET_KEY` (opcional): keypair JSON usado para firmar attestations on-chain.
- `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE` (opcional alternativa): path a un archivo con el keypair.

## Comandos

```bash
npm run test:back          # vitest backend
npm run lint               # eslint app + back/services
npx tsc --noEmit           # typecheck
```

## Programas Anchor

| Programa                  | Path                                | Rol                                                                         |
| ------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `agent-action-guard`      | `back/solana/agent-action-guard/`   | Approvals, attestations y enforcement on-chain de transfers/swaps guardados.|
| `conditional-escrow-buy`  | `back/solana/conditional-escrow-buy/` | Conditional buy SOL via oracle (Pyth) y escrow devnet.                     |

Direcciones devnet en [`docs/onchain-deployments.md`](../docs/onchain-deployments.md).

## Pendientes (post Wave 3.5)

- **Tool boundary dedicado.** El transfer guard hoy se invoca a través de helpers, no de un MCP server. Próxima wave: definir el entrypoint MCP/tool boundary que el agente consume.
- **Swap y conditional behind gateway** (Wave 4 según el migration plan).
- **Signer adapter explícito** (Wave 5).
- **Audit persistente.** Hoy es in-memory bounded; cuando haga falta retención, agregar una sink durable.
- **README/docs nuevos** cuando aterricen las próximas waves.
