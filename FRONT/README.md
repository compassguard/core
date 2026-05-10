# FRONT

Documentación y código de UI del frontend de Wallet Copilot.

## SSoT

La fuente de verdad para cualquier decisión de frontend es:

- `FRONT/docs/frontend-spec.md`

Si otro documento parece contradecirla, gana `frontend-spec.md` y el documento debe corregirse antes de implementar.

## Alcance actual del frontend

- Next.js 14+ App Router, TypeScript, Tailwind CSS + shadcn/ui.
- Código UI en `FRONT/src/`, exportado desde `FRONT/src/App.tsx` y consumido por `app/page.tsx`.
- Phantom Browser Extension para autenticación: conexión directa con wallet del usuario, sin SDK embebido ni OAuth.
- El frontend **no construye, firma ni envía transacciones** y **no habla directo con Solana RPC, Jupiter, Helius, Birdeye ni risk-score providers**.
- Toda ejecución de transacciones y toda integración blockchain/provider vive detrás del backend/agent (`/api/*` y `BACK/services/*`).

## Documentos útiles

- `docs/README.md` — índice: qué doc es actual, histórico o referencia.
- `docs/frontend-spec.md` — SSoT principal.
- `docs/functional-spec.md` — resumen funcional alineado al SSoT.
- `docs/technical-spec.md` — guía técnica de implementación frontend alineada al SSoT.
- `docs/api-boundary-and-fallback-ui.md` — política de límites frontend/backend y fallbacks visibles desde UI.
- `docs/task-specs/` — tareas documentales alineadas al plan por fases del SSoT.
- `docs/archive/` — documentos históricos, no usar para implementar.

No poner secrets en `FRONT/`. Si una integración necesita API key, crear/usar una ruta en `app/api/*` y lógica server-side en `BACK/services/*`.
