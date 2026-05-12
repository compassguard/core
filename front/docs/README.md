# front Docs Index

Este directorio está organizado para que se entienda **qué documento manda**, **para qué sirve cada doc** y **qué es histórico**.

## Regla principal

La fuente de verdad del frontend es:

- [`frontend-spec.md`](./frontend-spec.md)

Si cualquier otro doc contradice `frontend-spec.md`, se corrige el otro doc. No se implementa desde documentos archivados.

## Cómo leer estos docs

1. Leer primero [`frontend-spec.md`](./frontend-spec.md).
2. Usar [`functional-spec.md`](./functional-spec.md) para entender el producto en corto.
3. Usar [`technical-spec.md`](./technical-spec.md) para guiar estructura técnica sin salirse del SSoT.
4. Usar [`task-breakdown.json`](./task-breakdown.json) y [`task-specs/`](./task-specs/) para planificar trabajo por fases.
5. Mirar [`archive/`](./archive/) solo para contexto histórico, nunca como guía actual.
6. Mirar [`references/`](./references/) solo como material externo archivado.

## Docs activos

| Documento | Estado | Para qué sirve | Cuándo leerlo |
|---|---:|---|---|
| [`frontend-spec.md`](./frontend-spec.md) | **SSoT** | Define stack, arquitectura, wallet layer, layout, estado, API contracts, fases y scope. | Siempre antes de tocar frontend. |
| [`functional-spec.md`](./functional-spec.md) | Activo | Resumen funcional alineado al SSoT: qué experiencia se quiere construir y qué queda fuera. | Cuando querés entender “qué hace el producto”. |
| [`technical-spec.md`](./technical-spec.md) | Activo | Guía técnica de implementación: carpetas, providers React, API client, state machine y restricciones. | Cuando vas a diseñar/implementar código. |
| [`api-boundary-and-fallback-ui.md`](./api-boundary-and-fallback-ui.md) | Activo | Explica el límite frontend/backend para providers externos y cómo mostrar fallbacks que vienen del backend. | Cuando haya dudas sobre Jupiter/Helius/Birdeye/RPC/risk providers. |
| [`task-breakdown.json`](./task-breakdown.json) | Activo | Lista estructurada de tareas T1–T10 alineadas al SSoT. | Para planificar o trackear fases. |
| [`task-execution-report.md`](./task-execution-report.md) | Activo | Reporte de ejecución con subagentes lógicos, evidencias y validación. | Para revisar qué se implementó. |

## Task specs activos

Los task specs viven en [`task-specs/`](./task-specs/). Son specs pequeñas por fase, no fuentes de verdad independientes.

| Tarea | Documento | Objetivo |
|---|---|---|
| T1 | [`T1-layout-shell-mock-data.md`](./task-specs/T1-layout-shell-mock-data.md) | Layout responsive y mock data. |
| T2 | [`T2-phantom-auth-balances.md`](./task-specs/T2-phantom-auth-balances.md) | Phantom injected auth/display + balances desde backend. |
| T3 | [`T3-chat-mocked-backend.md`](./task-specs/T3-chat-mocked-backend.md) | Chat store + protocolo `/api/chat` mockeado. |
| T4 | [`T4-agent-swap-flow.md`](./task-specs/T4-agent-swap-flow.md) | Swap end-to-end vía agent, sin tx logic en frontend. |
| T5 | [`T5-safety-settings-polish.md`](./task-specs/T5-safety-settings-polish.md) | Safety UI, alerts, settings y estados async. |
| T6 | [`T6-api-contracts-zod.md`](./task-specs/T6-api-contracts-zod.md) | Contratos API propios + validación Zod. |
| T7 | [`T7-app-wiring.md`](./task-specs/T7-app-wiring.md) | Wiring de providers, AppShell y tabs. |
| T8 | [`T8-doc-validation.md`](./task-specs/T8-doc-validation.md) | Validación documental y control de contradicciones. |
| T9 | [`T9-api-boundary-fallback-ui.md`](./task-specs/T9-api-boundary-fallback-ui.md) | Boundary API y UI de fallbacks server-side. |
| T10 | [`T10-functional-validation.md`](./task-specs/T10-functional-validation.md) | Checklist funcional futuro. |

## Archivo histórico

[`archive/`](./archive/) contiene documentos de una arquitectura anterior donde el frontend incluía risk engine, providers externos, simulación y signing flow. Eso quedó obsoleto.

Leer esos documentos solo si necesitás entender por qué se descartó esa dirección. No usarlos para implementar.

## Referencias externas

[`references/`](./references/) contiene material externo o copias de documentación de terceros. No define arquitectura del frontend.

## Decisiones que deben permanecer consistentes en todos los docs

- El frontend es UI/chat + Phantom injected auth/display.
- El frontend no construye transacciones desde intención de usuario ni consulta providers externos.
- El frontend sí puede deserializar, firmar y enviar con Phantom una unsigned transaction preparada por backend.
- El frontend no llama directo a Solana RPC, Jupiter, Helius, Birdeye ni risk-score providers para lógica de negocio.
- El frontend consume endpoints propios `/api/*`; el chat/proposals usan `/api/chat`.
- Backend/agent decide risk, quotes, auto-execute vs confirmación y construcción canónica de transacciones.
