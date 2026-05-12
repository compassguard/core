# T9 Implementation Summary — Superseded

**Status:** superseded by `front/docs/frontend-spec.md`.

Este archivo antes documentaba integraciones reales con Jupiter, Birdeye, risk-score providers y Helius desde el frontend. Ese enfoque contradice la arquitectura actual y queda archivado.

## Decisión vigente

- El frontend no implementa providers externos.
- El frontend no maneja provider API keys ni variables `VITE_*` para providers.
- El frontend no ejecuta fetches directos a APIs de terceros.
- El frontend consume únicamente endpoints propios `/api/*` definidos en `frontend-spec.md`.
- El backend/agent es responsable de quotes, risk checks, fallbacks, ejecución y receipts.

## Implicación para nuevas tareas

Si se necesita modificar integraciones Jupiter/Helius/Birdeye/risk-score, documentarlo e implementarlo en backend (`app/api/*` / `back/services/*`), no en `front/src`.

Para frontend, T9 actual se interpreta como “verificar límites API y fallbacks de UI”, no como “implementar providers reales”.
