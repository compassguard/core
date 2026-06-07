# T9 Spec — API boundary and fallback UI

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Asegurar que el frontend trata providers externos como detalle de backend y solo muestra degradaciones/fallbacks comunicados por `/api/*`.

## Requirements

- No implementar Jupiter/Helius/Birdeye/risk-score providers en `front/src`.
- No requerir `VITE_*` ni `NEXT_PUBLIC_*` para provider API keys.
- Mostrar badges/copy de `mock`, `demo`, `unavailable` o `stale` cuando backend los incluya.
- Mantener retry/error/empty states para endpoints propios.

## Acceptance

- `docs/api-boundary-and-fallback-ui.md` refleja que los fallbacks reales viven server-side.
- Tests futuros mockean `/api/*`.
