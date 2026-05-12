# T6 Spec — API contracts + Zod validation

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Formalizar los contratos que el frontend consume desde backend y validarlos en runtime.

## Scope

- `front/src/types/api.ts` con tipos de `ApiError`, `AgentMessage`, wallet, allocation, transactions, network y prices.
- `front/src/lib/api/schemas.ts` con Zod schemas.
- API client para `/api/chat`, `/api/wallet/*`, `/api/network/status`, `/api/prices`.

## Acceptance

- Ningún schema representa responses directas de Jupiter/Helius/Birdeye/RPC.
- Errores backend siguen `{ error: { code, message, details? } }`.
- Tests futuros deben mockear `/api/*`, no proveedores externos.
