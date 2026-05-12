# front

Código y documentación de UI para Wallet Copilot. El frontend vive en `front/src/`, pero la app se renderiza desde Next vía `app/page.tsx`.

## Quick path

- SSoT frontend: `docs/frontend-spec.md`
- API reference transversal: `../docs/api-reference.md`
- Workflow/tests: `../docs/development-workflow.md`
- Boundary frontend/backend: `docs/api-boundary-and-fallback-ui.md`

## Alcance actual

- Next.js App Router, TypeScript, Tailwind CSS + shadcn/ui.
- UI exportada desde `front/src/App.tsx` y consumida por `app/page.tsx`.
- Phantom Browser Extension para conexión, firma y envío de transacciones preparadas por backend.
- El frontend no calcula riesgo, no consulta providers externos y no construye transacciones desde intención de usuario.
- Toda integración blockchain/provider de negocio, quotes, risk policy y construcción canónica de transacciones vive detrás de `/api/*` y `back/services/*`.

## Boundary

```txt
React UI/hooks
  -> front/src/lib/api/client.ts
    -> /api/*
      -> app/api/*/route.ts
        -> back/services/*
```

Reglas:

- No poner secrets en `front/`.
- No importar `@back/*` desde UI/hooks.
- Usar `front/src/lib/api/client.ts` como cliente único para APIs internas.
- Validar respuestas con `front/src/lib/api/schemas.ts` cuando haya contrato frontend.

## API client map

| Método/flujo | Ruta | Archivos relevantes |
|---|---|---|
| Chat stream y mensajes | `/api/chat` | `hooks/useAgentMessage.ts`, `stores/chatStore.ts`, `lib/api/client.ts` |
| Approve/reject/result | `/api/chat` | `hooks/useAgentMessage.ts`, proposal cards |
| Balances | `/api/wallet/balances` | `hooks/useWalletBalances.ts`, wallet components |
| Transactions | `/api/wallet/transactions` | `hooks/useTransactionHistory.ts` |
| Prices demo | `/api/prices` | `hooks/usePrices.ts` |
| Quote USDC/SOL | `/api/quotes/usdc-sol` | `lib/api/client.ts`, API schemas |
| Conditional orders | `/api/conditional-orders*` | `hooks/useConditionalOrders.ts`, `ConditionalOrdersPanel.tsx` |

> Nota: `/api/agent/message` es un endpoint histórico/obsoleto en docs viejos. El contrato actual es `/api/chat`.

## Estructura

| Path | Uso |
|---|---|
| `src/App.tsx` | Raíz visual de la app. |
| `src/components/` | Componentes de layout, chat, wallet, status y UI base. |
| `src/hooks/` | Hooks de wallet, chat, precios, balances e historial. |
| `src/lib/` | Cliente API, formateo, helpers y utilidades. |
| `src/providers/` | Providers React client-side. |
| `src/stores/` | Stores Zustand. |
| `src/styles/` | CSS global/Tailwind. |
| `src/types/` | Tipos frontend/API/chat/wallet. |
| `docs/` | Specs y documentación de frontend. |

## Documentos útiles

- `docs/README.md` — índice: qué doc es actual, histórico o referencia.
- `docs/frontend-spec.md` — SSoT principal.
- `docs/functional-spec.md` — resumen funcional alineado al SSoT.
- `docs/technical-spec.md` — guía técnica de implementación frontend alineada al SSoT.
- `docs/api-boundary-and-fallback-ui.md` — política de límites frontend/backend y fallbacks visibles desde UI.
- `docs/task-specs/` — tareas documentales alineadas al plan por fases del SSoT.
- `docs/archive/` — documentos históricos, no usar para implementar.

## Tests frontend

```bash
npm test
```

Incluye `front/src/**/*.{test,spec}.?(c|m)[jt]s?(x)` en entorno `jsdom`.

Si tocás imports globales, App Router o contratos API, corré además:

```bash
npm run lint
npm run build
```
