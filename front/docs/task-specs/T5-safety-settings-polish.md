# T5 Spec — Polish de safety UI y settings

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Pulir alerts, settings y estados async del frontend.

## Scope

- `RiskAlert`/`AlertBanner` para `medium` y `critical`.
- `GasCongestionAlert`/alertas standalone si el agent las envía.
- Settings sheet con auto-confirm threshold, risk warnings, account, export key y disconnect.
- Loading/error/empty states en BalanceCard, AssetAllocationDonut, ChatHistoryList y tabs.

## Acceptance

- El frontend no calcula risk; solo renderiza `risk.level`, `risk.score` y `risk.reasons` recibidos.
- `autoConfirmThresholdUsd` se guarda localmente y se envía al backend si corresponde.
- Disconnect limpia chat local.
