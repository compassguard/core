# 007 - Buy SOL at Target Price (Oracle On-Chain)

## Problem statement

Hoy el flujo de `conditional_buy_sol` (spec 004) evalúa condición de precio en backend simulado. Eso no garantiza enforcement criptográfico de la condición al momento de aprobación/ejecución.

Necesitamos que la condición **"comprar SOL solo si precio <= X"** se valide **on-chain** con oracle, para que la aprobación/ejecución no dependa exclusivamente del backend y sea auditable en devnet.

## Scope in/out

### In scope

1. Extender `AgentActionGuard` (spec 005) para validar precio on-chain contra oracle antes de marcar acción como ejecutada.
2. Definir action type on-chain para compra condicional de SOL.
3. Verificación de:
   - precio actual de SOL/USD,
   - freshness/staleness del feed,
   - confidence máxima permitida.
4. Integración backend/front para:
   - crear approval on-chain con target price,
   - solicitar `mark_executed_if_price_below`.
5. Flujo MVP en devnet con **simulación de ejecución** (sin swap real Jupiter).

### Out of scope

1. Ejecución real de swap en DEX/Jupiter.
2. Mainnet deployment.
3. Background bot automático de ejecución.
4. Multi-oracle aggregation.
5. Custodia de llaves o firma backend.

## Functional requirements

### FR-1: Nueva acción on-chain para buy condicional

Agregar soporte de acción `BUY_SOL_ORACLE_CONDITIONAL` en programa `AgentActionGuard`.

### FR-2: Approval debe incluir condición de precio

Al crear `ActionApproval` para buy condicional, el payload canónico debe incluir:

- `input_token` (MVP: USDC)
- `input_amount`
- `target_price_usd` (precio máximo permitido para SOL)
- `max_slippage_bps`
- `expires_at`
- `oracle_feed_pubkey`

Y generar `action_hash = sha256(canonical_json_params)`.

### FR-3: Validación on-chain con oracle

Nueva instrucción del contrato (nombre sugerido):

`mark_executed_if_price_below`

Debe validar antes de `executed=true`:

1. approval existe y corresponde a `user` + `action_hash`.
2. approval no expirado, no revocado, no ejecutado.
3. oracle feed coincide con el feed esperado en params/hash.
4. precio de SOL/USD del oracle <= `target_price_usd`.
5. dato del oracle no stale (publish time dentro de umbral).
6. confidence interval dentro de límite permitido.

Si alguna condición falla, la instrucción revierte.

### FR-4: Backend verify-before-respond

En `function_approve` del backend:

1. verificar evidencia de approval on-chain.
2. ejecutar transacción de `mark_executed_if_price_below` (firmada por user desde frontend).
3. si tx on-chain confirma, responder JSON success.
4. si falla condición de precio/oracle, responder error claro.

### FR-5: Frontend approve flow

El frontend debe:

1. mostrar propuesta de buy condicional con target price.
2. firmar tx de `create_action_approval`.
3. al confirmar final, firmar tx de `mark_executed_if_price_below`.

### FR-6: Decisiones funcionales

Para `user_message`:

- `ALLOW_WITH_CONFIRMATION`: condición válida y flujo listo.
- `WAIT_CONDITION_NOT_MET`: cuando backend simulado detecte precio > target antes de pedir approve.
- `REJECT`: params inválidos/política inválida.

Para `approve`:

- éxito solo si validación oracle on-chain pasa.

## Non-functional requirements (latency, security, auditability, idempotency)

### Latency

1. SSE first token < 2s para chat.
2. Operación approve (on-chain confirmación devnet) objetivo < 10s p95.

### Security

1. No backend signing de wallet de usuario.
2. Validación de oracle feed esperado (anti account substitution).
3. Validación de stale/confidence (anti bad data acceptance).

### Auditability

1. Registrar `action_hash`, `approval_pda`, `oracle_price`, `target_price`, `tx_signature`.
2. Logs con decisión on-chain pass/fail y razón.

### Idempotency

1. Segunda ejecución de `mark_executed_if_price_below` sobre approval ejecutado debe fallar de forma determinística.
2. `function_approve` repetido tras éxito debe devolver estado consistente (already executed).

## Data impact (new columns, migrations, indexes, backfill)

No DB relacional obligatoria para MVP (store in-memory actual).

Cambios de estado en memoria/backend:

1. pending proposal debe incluir `target_price_usd`, `oracle_feed_pubkey` y `action_hash`.
2. guardar `approval_pda` y `mark_executed_tx` al completar.

Sin migraciones SQL en esta etapa.

## API contract changes (request/response/status codes/errors)

### Request (chat proposal)

Para intención buy condicional, proposal metadata debe incluir:

- `action_type: "BUY_SOL_ORACLE_CONDITIONAL"`
- `target_price_usd`
- `oracle_feed_pubkey`

### Approve JSON response

Éxito:

```json
{
  "messages": [
    {
      "type": "text",
      "content": "Aprobación on-chain validada. Condición de precio cumplida.",
      "execute": {
        "status": "success",
        "tx_hash": "<mark_executed_tx_sig>"
      },
      "timestamp": "..."
    }
  ]
}
```

Error precio no cumplido:

```json
{
  "error": {
    "code": "price_condition_not_met",
    "message": "Current oracle price is above target price"
  }
}
```

Errores nuevos:

- `oracle_feed_mismatch`
- `oracle_data_stale`
- `oracle_confidence_too_high`
- `approval_not_found`
- `approval_already_executed`

## Authorization and permission expectations

1. `create_action_approval` y `mark_executed_if_price_below` deben ser firmadas por la wallet del usuario.
2. Backend no puede saltar la verificación on-chain.
3. `mark_executed_if_price_below` solo sobre approval perteneciente al `user` autenticado en sesión wallet.

## Observability requirements (logs/metrics/events)

### Logs obligatorios

1. `[oracle-buy] proposal_created` con `session_id`, `action_hash`, `target_price_usd`.
2. `[oracle-buy] onchain_check_pass` con `oracle_price`, `target_price_usd`, `tx_sig`.
3. `[oracle-buy] onchain_check_fail` con razón (`stale`, `price_above_target`, etc.).

### Métricas (si hay collector)

1. `oracle_buy_attempt_total`
2. `oracle_buy_success_total`
3. `oracle_buy_fail_total{reason=...}`
4. `oracle_buy_approve_latency_ms`

## Acceptance criteria (testable)

1. Dado un target price mayor al precio oracle actual, `mark_executed_if_price_below` marca executed=true.
2. Dado un target price menor al precio oracle actual, la instrucción falla y no marca executed.
3. Si oracle data está stale, la instrucción falla con error esperado.
4. Si oracle feed account no coincide con params/hash, la instrucción falla.
5. Reintentar ejecución de approval ya ejecutado falla determinísticamente.
6. Frontend muestra mensaje claro cuando condición no se cumple on-chain.
7. Backend responde JSON success con `tx_hash` al pasar validación on-chain.

## Design before code: vertical slices, risky steps, rollback

### Slice 1 - Contrato (base)

Archivos esperados:

- `programs/agent-action-guard/src/lib.rs` (o equivalente)
- structs/accounts para action conditional buy

Entregable:

- instrucción `mark_executed_if_price_below` compilando y testeada unitariamente.

### Slice 2 - Integración oracle

Riesgo alto:

- parse de precio/exponente/confidence según proveedor (Pyth/Switchboard).

Entregable:

- validación correcta de precio + stale + confidence.

### Slice 3 - Frontend wallet tx flow

Entregable:

- crear approval tx y mark-executed tx firmadas por usuario.

### Slice 4 - Backend orchestration

Entregable:

- `function_approve` conectado a estado on-chain + errores normalizados.

### Riesgos explícitos

1. **Cambio de precio entre propuesta y aprobación**: esperado; on-chain decide al instante final.
2. **Dependencia externa oracle**: manejar stale/confidence y fallback de error.
3. **Compatibilidad de unidades numéricas** (decimals/exponent): validar conversions con tests.

### Rollback strategy

1. Mantener feature flag `ORACLE_ONCHAIN_BUY_ENABLED=false` para volver al flujo simulado.
2. Si falla deploy o integración oracle, deshabilitar solo esta acción, sin romper `transfer`.

## Test plan (mapped to requirements)

### Unit tests

1. Hash canónico incluye target/oracle feed y es estable.
2. Parser de intent buy condicional (`price_below`) correcto.
3. Conversión de precio oracle a formato comparable USD correcta.

### Program tests (integration on local validator/devnet)

1. `initialize_policy` success.
2. `create_action_approval` para buy condicional success.
3. `mark_executed_if_price_below` success cuando precio <= target.
4. `mark_executed_if_price_below` fail cuando precio > target.
5. fail con stale/confidence alta/feed mismatch.

### Backend integration tests

1. `function_approve` devuelve success tras tx on-chain válida.
2. `function_approve` devuelve `price_condition_not_met` cuando oracle fail.

### Regression tests

1. Flujo `transfer` existente no se rompe.
2. SSE contract actual sigue funcionando.

## Discovery summary (goal, constraints, impacts)

### Business goal

Demostrar guardrail fuerte: condición de precio verificable on-chain para compra de SOL.

### Non-goals

No swap real, no bot automático, no mainnet.

### Current behavior

Buy condicional está definido en spec 004 pero no implementado con enforcement on-chain.

### Constraints

1. Hackathon timeline.
2. Devnet only.
3. Mantener contrato chat actual SSE/JSON.

### Affected modules / ownership boundaries

1. Smart contract (`AgentActionGuard`) - on-chain.
2. BACK services chat/approval - server.
3. FRONT wallet signing flow - client.

### Backward compatibility

1. `transfer` permanece igual.
2. Nuevos campos en proposal de buy condicional deben ser aditivos.

## Open risks / follow-ups

1. Definir proveedor oracle oficial para MVP (Pyth recomendado) y feed SOL/USD devnet exacto.
2. Definir política exacta de confidence threshold.
3. Definir si `mark_executed` la firma solo user o también autoridad agente post-MVP.

---

**Status:** Implemented (MVP)  
**Owner:** BACK + FRONT + Solana Program  
**Created:** 2026-05-10

## Implementation notes

- Se agregó tool `conditional_buy_sol` en backend con decisión `ALLOW_WITH_CONFIRMATION | WAIT_CONDITION_NOT_MET | REJECT`.
- `function_approve` ahora soporta `execute_tx_signature` para validar evidencia on-chain de ejecución oracle-gated.
- Se creó módulo `onchainApproval.ts` para verificar que la tx invoca `AGENT_ACTION_GUARD_PROGRAM_ID` y está confirmada en devnet.
- Se agregó scaffold Anchor del programa `AgentActionGuard` con:
  - `create_action_approval`
  - `mark_executed_if_price_below`
  - validaciones `stale/confidence/price <= target` vía Pyth.
- Se documentó setup/deploy en `BACK/solana/agent-action-guard/README.md`.
