# back

Código backend/server-side reutilizable para la app Next. Esta carpeta **no** corre como servidor separado: las funciones de `back/services/*` son llamadas por route handlers estándar en `app/api/*`.

## Quick path

- API reference: `../docs/api-reference.md`
- Workflow/tests: `../docs/development-workflow.md`
- On-chain devnet config: `../docs/onchain-deployments.md`

## Boundary

```txt
front/src/lib/api/client.ts
  -> app/api/*/route.ts
    -> back/services/*
      -> providers externos / RPC / programas Solana
```

Reglas:

- Secrets y API keys viven server-side.
- No importar `back/*` desde componentes/hook browser-side.
- Las acciones críticas deben pasar por guardrails antes de construir o pedir firma de transacciones.
- Los route handlers validan input en el borde y delegan lógica real a `back/services/*`.

## Route/service map

| Ruta | Servicio dueño | Nota |
|---|---|---|
| `/api/chat` | `services/chat.ts` | Chat agentic, proposals, approvals, historial y resultados. |
| `/api/conditional-orders` | `services/conditionalOrders.ts` | Lista/refresco de órdenes condicionales devnet. |
| `/api/conditional-orders/[orderPda]` | `services/conditionalOrders.ts` | Detalle y trigger manual de ejecución. |
| `/api/quotes/usdc-sol` | `services/priceQuote.ts` | Quote Orca devnet USDC/SOL. |
| `/api/wallet/balances` | `services/walletHoldings.ts` | Holdings nativos/SPL. |
| `/api/wallet/transactions` | `services/transactionHistory.ts` | Historial vía provider. |
| `/api/jupiter/quote` | `services/jupiter.ts` | Proxy Jupiter. |
| `/api/birdeye/token-security` | `services/birdeye.ts` | Seguridad de token. |
| `/api/risk-score` | `services/riskScore.ts` | Score de riesgo. |
| `/api/helius/transactions` | `services/helius.ts` | Proxy Helius. |

Los endpoints mock/demo están documentados en `../docs/api-reference.md`.

## Servicios importantes

| Servicio | Responsabilidad |
|---|---|
| `chat.ts` | Orquestación del agente, tools, proposals, approval flow y SSE. |
| `walletSafetyValidation.ts` | Evaluación de seguridad de destino/token/políticas. |
| `onchainApproval.ts` | Verificaciones on-chain relacionadas a guardrails. |
| `conditionalOrders.ts` | Indexer/watcher/keeper de conditional orders. |
| `tools/*` | Tools invocadas por el agente: transfer, swap, conditional buy, guardrails. |
| `solanaConnection.ts` | Conexión RPC centralizada para evitar rate limiting y drift de configuración. |

## Variables de entorno

Configurar en Vercel o `.env.local` en la raíz. No commitear valores reales.

| Grupo | Variables | Requerimiento |
|---|---|---|
| Jupiter | `JUPITER_API_URL` | Opcional con default según servicio. |
| Birdeye | `BIRDEYE_API_KEY`, `BIRDEYE_API_URL` | Necesario para token security live. |
| Risk score | `RISK_SCORE_API_URL`, `RISK_SCORE_API_KEY` | Necesario para provider externo si está activo. |
| Helius | `HELIUS_API_KEY`, `HELIUS_API_URL` | Necesario para historial/provider Helius. |
| LLM | `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, `OPENAI_RESPONSES_ENDPOINT` | Necesario para chat agentic live; modelo y endpoint se configuran por entorno. `OPENAI_API_URL` + `AZURE_OPENAI_API_VERSION` quedan como fallback legacy. |
| Chat store | `CHAT_SESSION_REDIS_REST_URL`, `CHAT_SESSION_REDIS_REST_TOKEN` | Recomendado en Vercel para persistir sesiones. |
| Upstash/Vercel KV aliases | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Alternativas aceptadas para chat store. |
| Solana/devnet | Ver `../docs/onchain-deployments.md` y `.env.example` | Program IDs, mints, feeds y keeper opcional. |

## Tests backend

```bash
npm run test:back
```

Incluye:

- `back/services/**/*.{test,spec}.*`
- `app/api/**/*.{test,spec}.*`

Si tocás route handlers o servicios, corré también:

```bash
npm run lint
npm run build
```

## Checklist para sumar un servicio

- [ ] Crear servicio en `back/services/*` o `back/services/tools/*`.
- [ ] Mantener secrets/env access dentro del backend.
- [ ] Crear/actualizar route handler en `app/api/*` si el frontend lo consume.
- [ ] Agregar tests de servicio o route handler.
- [ ] Actualizar `../docs/api-reference.md`.
- [ ] Actualizar feature spec en `../docs/<feature>/` si cambia comportamiento.
