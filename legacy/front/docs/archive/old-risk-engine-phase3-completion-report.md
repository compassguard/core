# Phase 3 Completion Report — Superseded

**Status:** superseded by `front/docs/frontend-spec.md`.

Este reporte correspondía a una fase anterior donde el frontend contenía un risk engine provider-based, simulación de transacciones y llamadas/fallbacks a APIs externas. Esa arquitectura ya no debe guiar el trabajo actual.

## Arquitectura vigente

- `front/src/App.tsx` es el entrypoint UI consumido por `app/page.tsx`.
- La UI se organiza en layout responsive, wallet/display, sidebar, chat, proposals, alerts y status.
- El protocolo vigente es function-calling vía `POST /api/chat`.
- El frontend mantiene una sola propuesta pendiente por sesión y bloquea el input hasta Confirm/Cancel.
- Toda ejecución blockchain ocurre server-side en el agent/backend.

## Qué quedó obsoleto

No usar este reporte como fuente para:

- `src/pages/Index.tsx` como entrypoint principal.
- Wallet adapter legacy o `sendTransaction` desde frontend.
- Simulación de transacciones desde frontend.
- Risk providers en cliente.
- Variables `VITE_*` para provider API keys en frontend.
- Tests de provider integrations desde `front/src`.

## Documento fuente

Usar `front/docs/frontend-spec.md` para fases, contratos API, componentes, estado y alcance.
