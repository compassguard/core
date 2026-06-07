# API Boundary & Fallback UI — Frontend

**Estado:** activo, boundary doc.  
**Para qué sirve:** evitar confusión sobre providers externos y definir qué fallbacks muestra la UI.  
**Historia:** reemplaza el doc viejo donde el frontend implementaba fallbacks reales contra APIs de terceros.

> Alineado a `front/docs/frontend-spec.md`. El frontend no implementa provider fallbacks externos; solo consume endpoints propios y muestra estados/fallbacks que el backend/agent ya decidió.

## Principio

El frontend debe ser agnóstico de providers externos. No sabe si los datos vienen de Jupiter, Helius, Birdeye, Solana RPC, mocks o cache. Esa decisión vive en backend/agent (`app/api/*` + `back/services/*`).

```txt
Frontend
  -> /api/chat
  -> /api/wallet/*
  -> /api/network/*
  -> /api/prices
      -> backend/agent/services
          -> Solana RPC / Jupiter / Helius / Birdeye / risk providers / mocks
```

## Qué NO debe hacer el frontend

- No llamar directamente a Jupiter Quote API.
- No llamar directamente a Helius.
- No llamar directamente a Birdeye.
- No llamar directamente a RugCheck, Solana Tracker u otros risk-score providers.
- No abrir conexiones RPC de Solana desde cliente.
- No manejar provider API keys en variables públicas.
- No simular ni construir transacciones desde intención de usuario.
- Sí puede firmar/enviar con Phantom injected una unsigned transaction preparada por el backend.

## Qué SÍ debe hacer el frontend

- Consumir endpoints propios `/api/*`.
- Validar responses con Zod.
- Mostrar loading/error/empty/data states.
- Renderizar señales de riesgo, provider, fees y receipts si vienen en la respuesta del backend.
- Etiquetar claramente datos `mock`, `demo`, `stale` o `unavailable` cuando el backend mande esos flags/copy.
- Hacer refetch de balances/allocation/history tras `text+execute` exitoso.

## Fallbacks visibles desde UI

El backend puede devolver flags o copy para indicar degradación. El frontend solo los presenta:

| Caso backend | UI esperada |
|---|---|
| Provider real disponible | Mostrar datos normalmente. |
| Provider mock/demo | Badge “Demo data” o copy equivalente. |
| Provider unavailable no bloqueante | Warning/info discreto. |
| Provider unavailable bloqueante | `function_call` con `risk.level = 'critical'` o error de API definido por backend. |
| Balance/history no disponible | Estado error con retry; no crash. |

## Endpoints frontend

| Endpoint | Uso | Fallback UI |
|---|---|---|
| `POST /api/chat` | Chat, approvals, execution results | Toast/error message; liberar input según estado. |
| `GET /api/wallet/balances` | Balance total y assets | Skeleton, `$0.00`/empty, retry. |
| `GET /api/wallet/allocation` | Donut de allocation | Skeleton, “Sin assets”, ocultar si error. |
| `GET /api/wallet/transactions` | Tab History | Skeleton, “Sin historial”, retry. |
| `GET /api/network/status` | Mainnet connected/latency | Estado degraded/unknown. |
| `GET /api/prices` | Display USD | Mantener último valor cacheado o mostrar “—”. |

## Variables de entorno

El flujo actual con Phantom injected/browser extension no requiere `NEXT_PUBLIC_PHANTOM_APP_ID`.

Solo usar variables `NEXT_PUBLIC_*` para configuración explícitamente pública de UI. Cualquier key para RPC, Helius, Birdeye, Jupiter o risk providers debe permanecer server-side y documentarse en backend, no en `front/docs` como requisito del cliente.

## Testing/validación futura

Cuando se implemente código, los tests del frontend deben mockear `/api/*`, no APIs externas. El objetivo es validar estados de UI y contratos Zod, no integraciones provider reales.
