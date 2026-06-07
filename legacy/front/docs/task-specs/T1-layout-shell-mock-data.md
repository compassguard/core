# T1 Spec — Layout shell + mock data

> Alineado a `front/docs/frontend-spec.md`. El nombre histórico del archivo queda, pero el contenido vigente sigue el SSoT.

## Objective

Crear la base visual del frontend sin lógica blockchain.

## Scope

- Next.js App Router consume `front/src/App.tsx`.
- `AppShell` responsive con desktop 3 columnas y mobile chat-first.
- Componentes shadcn/Tailwind con datos hardcoded del mockup.
- `TopBar`, `BottomNav`, sidebar, chat container, right panel/assets.

## Acceptance

- La UI se parece al mockup con mock data.
- No hay llamadas RPC/provider.
- No hay signing/build/submit de transacciones.
- No se introducen secrets ni env vars de providers.
