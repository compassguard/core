# Implementation Summary — Superseded

**Status:** superseded by `front/docs/frontend-spec.md`.

Este archivo antes describía una implementación de un risk engine/provider flow dentro del frontend. Ese enfoque ya no es la arquitectura vigente.

## Decisión actual

- El frontend es un cliente de UI/chat.
- Phantom Embedded se usa solo para login, address/display, export key y disconnect.
- El frontend no construye, simula, firma ni envía transacciones.
- El frontend no consume Solana RPC, Jupiter, Helius, Birdeye ni risk-score providers directamente.
- Risk policy, quotes, provider fallbacks, receipts y ejecución de transacciones viven en backend/agent.

## Fuente de verdad

Para cualquier implementación nueva usar:

1. `front/docs/frontend-spec.md`
2. `front/docs/functional-spec.md`
3. `front/docs/technical-spec.md`
4. `front/docs/task-specs/`

## Nota histórica

Cualquier referencia previa a `SafetyReviewPanel`, `sendTransaction`, `src/pages/Index.tsx`, variables `VITE_*` de providers, simulación cliente o tests de risk providers debe tratarse como historial obsoleto y no como instrucción de implementación actual.
