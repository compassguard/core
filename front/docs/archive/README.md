# Archive

Este directorio contiene documentación histórica que **ya no define la arquitectura actual**.

## Por qué existe

Antes se documentó una dirección donde el frontend tenía:

- risk engine determinístico en cliente;
- providers para Jupiter/Helius/Birdeye/risk-score dentro de `front/src`;
- simulación de transacciones pre-signing desde frontend;
- wiring con `sendTransaction`/wallet adapter;
- summaries de implementación TDD/Phase 3.

Esa dirección fue reemplazada por el SSoT actual: [`../frontend-spec.md`](../frontend-spec.md).

## Cómo usar estos docs

- ✅ Leer para contexto histórico.
- ✅ Leer para entender qué se descartó.
- ❌ No implementar desde acá.
- ❌ No copiar endpoints/provider keys/flows de signing al frontend.

## Contenido

| Documento | Historia |
|---|---|
| [`old-risk-engine-implementation-summary.md`](./old-risk-engine-implementation-summary.md) | Summary de una implementación anterior de risk engine en frontend. |
| [`old-risk-engine-phase3-completion-report.md`](./old-risk-engine-phase3-completion-report.md) | Completion report histórico de esa fase. |
| [`old-risk-engine-t9-implementation-summary.md`](./old-risk-engine-t9-implementation-summary.md) | Summary histórico de providers reales en frontend. |
| [`old-reverse-engineering-spec.html`](./old-reverse-engineering-spec.html) | Spec HTML anterior, reemplazada por el SSoT actual. |
