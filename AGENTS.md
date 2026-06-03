# AGENTS

## Proyecto

Compass está migrando hacia **Compass MCP Guard**: un execution firewall para agentes de IA que operan en Solana.
La fuente canónica de producto es `docs/PRODUCT_CONSTITUTION.md`.

La idea principal es permitir que agentes y usuarios ejecuten operaciones comunes, pero siempre con una capa extra de validación, policy, simulación/decoding, aprobación y auditoría antes de ejecutar acciones on-chain.

Arquitectura actual (alto nivel):

- `front`: experiencia de usuario y flujos de operacion.
- `back`: servicios y reglas server-side (integrados en Next API routes), con validaciones previas y consultas a proveedores externos.

## Objetivo del guardrail

Antes de permitir una operacion, el sistema debe evaluar riesgo, contexto y reglas definidas.
Esto puede incluir:

- Verificaciones en backend (listas de bloqueo, reputacion, patrones sospechosos, checks de destino).
- Verificaciones con smart contracts para enforcement en ciertos casos.
- Rechazo o confirmacion reforzada cuando una accion no cumpla reglas de seguridad.

## Features principales planeadas

1. **MCP / execution gateway**
   - Tool boundary para agentes AI y MCP clients.
   - Clasificación de tools, policy engine, risk engine, simulación/decoding y audit log.

2. **Transferencia a otra wallet**
   - Flujo para enviar fondos/tokens a otra direccion.
   - Validaciones de seguridad sobre la wallet destino antes de firmar/ejecutar.

3. **Swap a otro token**
   - Flujo de cotizacion y swap.
   - Validaciones sobre token de salida/entrada, riesgo del token y condiciones de ejecucion.

4. **Transaccion condicional recurrente**
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

## Fuente unica de artefactos SDD

No duplicar el mismo proposal/spec/task en `docs/` y `openspec/changes/` al mismo tiempo.
Para cada cambio, elegir **una sola fuente canonica** antes de escribir artefactos:

- Usar `docs/<nombre-feature>/...` cuando el trabajo sea una feature o decision de producto de este repo.
- Usar `openspec/changes/<change-id>/...` solo cuando el usuario pida explicitamente flujo OpenSpec, archivo OpenSpec, o archive/sync OpenSpec.

Si hay duda, preguntar antes de crear ambos. No mantener copias espejadas salvo instruccion explicita del usuario.

## Politica de ramas para migracion Compass MCP Guard

No mergear cambios de la migracion directo a `main` mientras la app actual siga funcionando ahi.
Usar esta estructura:

- `main`: rama estable; no recibe waves de migracion hasta aprobacion explicita.
- `release/compass_migration`: rama de integracion para acumular las waves del MVP.
- `feature/wave-<n>-<descripcion>`: ramas chicas por wave o sub-feature.

Cada rama `feature/wave-*` debe salir de `release/compass_migration` y mergearse de vuelta a `release/compass_migration`, no a `main`.
Si una herramienta propone abrir PR contra `main`, corregir la base a `release/compass_migration` antes de continuar.

## Principio de implementacion

Ninguna operacion critica debe ejecutarse sin pasar primero por la capa de guardrails.
Si una validacion falla, el sistema debe responder con motivo claro y accion sugerida (bloquear, pedir confirmacion extra o reintentar bajo nuevas condiciones).
