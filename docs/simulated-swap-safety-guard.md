# 002 - Token Risk Guard para swaps iniciados por agente

## Resumen

Este indice reemplaza la especificacion monolitica anterior por una vista breve de la arquitectura **Token Risk Guard** y deriva el detalle a documentos separados por responsabilidad.

El objetivo del guard es evaluar, antes de ejecutar un swap hacia un token, si existen senales de colapso, rug pull, baja calidad de mercado o mala inversion probable. La evaluacion combina datos off-chain de mercado/reputacion con una validacion on-chain compacta y deterministica.

## Documentos

- [Frontend Token Risk Guard](front/docs/token-risk-guard-frontend.md): responsabilidades de UI, conexion Phantom, estados, metadata API/SSE consumida, firma del usuario y criterios demo del frontend.
- [Backend y on-chain Token Risk Guard](docs/token-risk-guard-backend.md): intent parsing, quote/risk engine, scoring, reportes canonicos, firma oracle/backend, pending actions, auditoria y validacion `AgentActionGuard`.

## Arquitectura compartida

La arquitectura separa tres planos:

- **Frontend**: conecta Phantom, muestra preview de quote/riesgo, comunica estados y solicita la firma del usuario.
- **Backend/off-chain risk engine**: interpreta la intencion, obtiene quote y datos de riesgo, calcula score, firma un reporte canonico y persiste la accion pendiente.
- **On-chain `AgentActionGuard`**: no calcula reputacion, liquidez ni holders; valida hechos deterministicos, hashes, firmas, expiracion, politica y estado de ejecucion.

Principios obligatorios:

1. **Phantom vive en frontend**: cualquier firma de la wallet del usuario ocurre en la UI mediante Phantom.
2. **No embedded wallet**: el producto no debe crear ni custodiar una wallet embebida para ejecutar swaps del usuario.
3. **Backend no firma por el usuario**: el backend puede firmar reportes como oracle autorizado, pero nunca una aprobacion o transaccion de la wallet del usuario.
4. **Riesgo off-chain, autorizacion on-chain**: las senales dinamicas se calculan fuera de la cadena; el programa on-chain valida compromisos firmados, frescos y reproducibles.
5. **Datos canonicos y politica versionada**: `quoteHash`, `riskReportHash` y `policyVersion` deben permitir auditoria y replay deterministico de la decision.

## Flujo de alto nivel

1. El usuario o agente propone un swap.
2. El backend obtiene quote, calcula riesgo y crea una `PendingSwapAction`.
3. El frontend muestra quote, score, warnings/reject reasons, fuentes, modo de proveedor y expiracion.
4. Si no hay hard reject, el usuario firma en Phantom desde el frontend.
5. `AgentActionGuard` valida usuario, parametros exactos, hashes, firma oracle/backend, expiracion, politica, umbrales y anti-replay.
6. El resultado queda auditado con decision, evidencia, estado final y, si aplica, transaction signature.

## Alcance

Incluido:

- Separacion documental entre frontend y backend/on-chain.
- Contratos de datos relevantes para preview, API/SSE, reportes, acciones pendientes y aprobacion on-chain.
- Reglas de `hard reject` y `warning`.
- Criterios de aceptacion y casos demo por area.

Fuera de alcance:

- Implementacion de contratos, endpoints, UI o integraciones.
- Estrategias de trading o promesas de rendimiento.
- Calculo on-chain de reputacion, liquidez, holder count, volumen o datos historicos.
