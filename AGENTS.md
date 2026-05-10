# AGENTS

## Proyecto

Este proyecto es una app enfocada en **guardrails para actividades en Solana**.
La idea principal es permitir operaciones comunes del usuario, pero con una capa extra de validacion y seguridad antes de ejecutar acciones on-chain.

Arquitectura actual (alto nivel):
- `FRONT`: experiencia de usuario y flujos de operacion.
- `BACK`: servicios y reglas server-side (integrados en Next API routes), con validaciones previas y consultas a proveedores externos.

## Objetivo del guardrail

Antes de permitir una operacion, el sistema debe evaluar riesgo, contexto y reglas definidas.
Esto puede incluir:
- Verificaciones en backend (listas de bloqueo, reputacion, patrones sospechosos, checks de destino).
- Verificaciones con smart contracts para enforcement en ciertos casos.
- Rechazo o confirmacion reforzada cuando una accion no cumpla reglas de seguridad.

## Features principales planeadas

1. **Transferencia a otra wallet**
   - Flujo para enviar fondos/tokens a otra direccion.
   - Validaciones de seguridad sobre la wallet destino antes de firmar/ejecutar.

2. **Swap a otro token**
   - Flujo de cotizacion y swap.
   - Validaciones sobre token de salida/entrada, riesgo del token y condiciones de ejecucion.

3. **Transaccion condicional recurrente**
   - Ejemplo: "Comprame SOL cuando baje de 130 USD".
   - Motor de condiciones + ejecucion automatizada/recurrente bajo reglas de riesgo.

## Reglas y validaciones esperadas

Para cada feature, aplicar una combinacion de controles:
- **Seguridad de wallet destino**: reputacion, actividad sospechosa, banderas de riesgo.
- **Seguridad de token/protocolo**: score de riesgo, señales anti-scam/rug.
- **Politicas de usuario**: limites por monto, frecuencia, allowlist/denylist.
- **Condiciones de ejecucion**: precio, slippage, ventanas de tiempo, estado de red.
- **Enforcement**:
  - Backend rules engine para validaciones rapidas y decision de permit/deny.
  - Smart contracts cuando se requiera garantia on-chain o restricciones no bypassables.

## Convencion de specs por feature

Las specs SDD de nuevas features no deben escribirse directamente en `docs/` como archivos globales.
Cada feature debe tener su propia carpeta:

- `docs/<nombre-feature>/functional-spec.md`
- `docs/<nombre-feature>/technical-spec.md`
- `docs/<nombre-feature>/task.json`

Usar `kebab-case` para `<nombre-feature>`; por ejemplo `docs/wallet-balance-display/`.
Antes de crear una spec nueva, revisar si ya existe una carpeta para esa feature y continuar ahi.
Solo usar archivos en la raiz de `docs/` para documentacion transversal, indices o documentos historicos ya existentes.

## Principio de implementacion

Ninguna operacion critica debe ejecutarse sin pasar primero por la capa de guardrails.
Si una validacion falla, el sistema debe responder con motivo claro y accion sugerida (bloquear, pedir confirmacion extra o reintentar bajo nuevas condiciones).
