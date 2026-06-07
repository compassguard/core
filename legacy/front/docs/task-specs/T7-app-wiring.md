# T7 Spec — App wiring

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Integrar providers React, shells responsive y estado global en la app.

## Requirements

- `app/layout.tsx` o el wrapper equivalente monta Query/Phantom/Theme providers.
- `app/page.tsx` importa `front/src/App.tsx`.
- `AppShell` decide desktop/mobile por breakpoint `md`.
- Tabs Chat/Assets/Explore/History respetan scope: Explore placeholder, History desde `/api/wallet/transactions`.

## Acceptance

- No hay `front/src/pages/Index.tsx` como entrypoint principal.
- No hay wiring de signing o RPC cliente.
