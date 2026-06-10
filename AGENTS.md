# AGENTS

## Proyecto

Compass está migrando hacia **Compass MCP Guard**: un execution firewall para agentes de IA que operan en Solana.
La fuente canónica de producto es `docs/PRODUCT_CONSTITUTION.md`.

La idea principal es permitir que agentes y usuarios ejecuten operaciones comunes, pero siempre con una capa extra de validación, policy, simulación/decoding, aprobación y auditoría antes de ejecutar acciones on-chain.

Arquitectura actual despues de Wave 3.5 (alto nivel):

- `app`: entrypoints mínimos de Next para la landing pública (`/`), redirect `/landing` y página WIP `/launch`.
- `back`: servicios MCP Guard server-side (execution gateway, policy, transfer guard, audit, on-chain approval, providers compartidos) y programas Anchor.
- `legacy`: snapshot del producto anterior chat/wallet (`front`, `app/api`, `app/home`, servicios legacy y docs historicos). El árbol principal no debe importar desde `legacy/`.

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

## Regla de aislamiento legacy

`legacy/` es solo referencia historica del producto anterior. No usarlo como dependencia del MCP Guard nuevo.

- No importar desde `legacy/` en `app/`, `back/`, `shared/`, `docs/` activos ni scripts nuevos.
- Si una capacidad legacy sigue siendo necesaria, extraerla a un módulo nuevo del árbol principal con tipos/contratos propios.
- Mantener `legacy/` excluido de lint/test/typecheck principales; usar `lint:legacy` o `test:legacy` solo cuando se trabaje explícitamente sobre legacy.

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

## Cuenta GitHub del proyecto

La cuenta GitHub correcta para pushear este proyecto es `ram4_dev`.
Puede pasar que `gh` quede autenticado como `rcarnicer_meli` porque el entorno comparte credenciales.
En este entorno `gh auth status` puede mostrar esa cuenta como `ram4-dev`.
Si un push falla por permisos contra `ram4-dev/solana_hackathon`, ejecutar `gh auth switch -u ram4-dev` y reintentar el push.

## Principio de implementacion

Ninguna operacion critica debe ejecutarse sin pasar primero por la capa de guardrails.
Si una validacion falla, el sistema debe responder con motivo claro y accion sugerida (bloquear, pedir confirmacion extra o reintentar bajo nuevas condiciones).

## Convencion de tipos

Los tipos, interfaces, enums/constantes canonicas y contratos compartidos deben vivir siempre en un archivo separado del comportamiento o la logica de negocio.

- Evitar mezclar types/contracts con funciones que ejecutan reglas, IO, validaciones o side effects.
- Preferir archivos dedicados como `*Types.ts`, `*Contracts.ts` o `*Schema.ts` cuando el schema sea estrictamente contractual.
- Las funciones de negocio deben importar los tipos desde ese archivo dedicado.
- Si una feature empieza chica, mantener igual la separacion desde el inicio para evitar refactors posteriores.
