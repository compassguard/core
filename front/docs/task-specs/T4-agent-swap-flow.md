# T4 Spec — Swap end-to-end vía agent

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Conectar el chat al agent real para que el backend decida auto-ejecución vs confirmación y ejecute transacciones server-side.

## Scope

- `user_message` puede devolver `text+execute` para auto-ejecución.
- `user_message` puede devolver `function_call` para aprobación manual.
- Confirm envía `function_approve`; Cancel envía `function_reject`.
- `text+execute` cierra propuesta activa y dispara refetch de balances/allocation.

## Acceptance

- Frontend no construye, simula, firma ni envía txs.
- Frontend no necesita tx IDs internos/call IDs porque solo hay una propuesta pendiente.
- Estados de card: pending, awaiting_execution, confirmed, failed, cancelled.
