# 003 — Approve Swap with Oracle Guard Execution (Agent Integration)

## Problem statement
El smart contract `agent-action-guard` ya incluye la instrucción `mark_executed_if_swap_price_within_band`, pero el flujo actual del agente para swap aún no la usa end-to-end. Hoy el approve de swap firma/envía una transacción de swap sin un paso obligatorio de ejecución del guard oracle on-chain previo a confirmar resultado.

Necesitamos integrar `approve -> guard execute -> result` para que el agente no pueda considerar exitoso un swap si no pasó validación on-chain de desviación de precio contra Pyth.

## Discovery

### Business goal
- Forzar validación de seguridad on-chain para swaps antes de marcar `confirmed`.
- Mantener UX de aprobación por wallet (el agente no ejecuta solo).

### Non-goals
- No rediseñar motor de quote/routing completo.
- No cambiar transfer y conditional-buy existentes salvo ajustes de compatibilidad.
- No desplegar a mainnet en esta fase.

### Current behavior
- `function_approve` para `swap_orca_usdc_to_sol` devuelve `transaction` (swap tx) y `proposal_state`.
- Frontend (`useAgentMessage`) firma/envía `response.transaction` y reporta `function_result` (`submitted/confirmed`) directamente.
- `verifyOracleExecutionTx` valida invocación del programa guard para flujo conditional buy, no hay path específico de swap guard integrado en approve flow.

### Constraints
- Devnet only.
- Debe usar `AGENT_ACTION_GUARD_PROGRAM_ID` y `PYTH_SOL_USD_FEED` ya configurados.
- Debe coexistir con historial de sesiones/pending proposals.

### Affected modules / ownership boundaries
- On-chain (ya implementado):
  - `BACK/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs`
- Backend:
  - `BACK/services/chat.ts`
  - `BACK/services/onchainApproval.ts`
  - potencial helper nuevo de integración guard-swap (si conviene separar)
- Frontend:
  - `FRONT/src/hooks/useAgentMessage.ts`
  - `FRONT/src/lib/api/{schemas.ts,client.ts}`
  - tipos API/chat de proposal execution metadata

### Data-model impact and migration risks
- `pendingProposal.toolResult/toolArgs` deberá persistir metadatos necesarios para guard swap:
  - `quoted_price_usd_e8`
  - `max_deviation_bps`
  - `staleness_seconds`
  - `max_confidence_bps`
  - `oracle_feed`
- Riesgo: incompatibilidad con proposals antiguas sin esos campos.
- Mitigación: fallback defensivo y error explícito `missing_swap_guard_metadata`.

### API consumers and backward compatibility
- Consumidores:
  - Frontend approve flow
  - Backend API `/api/chat` (`function_approve`, `function_result`)
- Compatibilidad:
  - `transfer` y `conditional_buy_sol` deben seguir funcionando igual.
  - Nuevos campos en responses serán opcionales para no romper clientes antiguos.

## Scope in/out

### In scope
- Integrar ejecución on-chain de `mark_executed_if_swap_price_within_band` en approve swap.
- Asegurar que `function_result confirmed` solo ocurra si guard pasó.
- Exponer errores claros de rechazo (`price_deviation_too_high`, `oracle_stale`, etc.).

### Out of scope
- Multi-oracle quorum.
- Repricing automático de swap ante rechazo.
- Optimización avanzada de compute budget/prioritization fees.

## Functional requirements
1. En approve de swap, el sistema debe preparar/transportar metadatos de guard oracle requeridos por la instrucción on-chain.
2. El frontend debe ejecutar secuencia controlada:
   1) firmar/enviar transacción guard (`mark_executed_if_swap_price_within_band`) o transacción compuesta según diseño final,
   2) solo si éxito, continuar con transacción de swap (si aplica en diseño),
   3) reportar `function_result`.
3. Si guard falla, el estado de proposal debe quedar `failed` con motivo específico.
4. `function_result confirmed` no debe emitirse cuando guard falló.
5. Backend debe verificar que tx de ejecución incluye invocación al programa guard esperado para swaps protegidos.
6. Definir dos bandas de desviación para swaps protegidos:
   - **warning band (no bloqueante):** `warning_deviation_bps < deviation_bps <= max_deviation_bps`
   - **critical band (bloqueante):** `deviation_bps > max_deviation_bps`
7. Cuando la desviación esté en warning band, el frontend debe mostrar una alerta visible de "precio poco favorable" al usuario (sin bloquear ejecución).

## Non-functional requirements

### Latency
- No agregar más de 1 round-trip adicional de wallet confirmation respecto al diseño elegido (documentarlo claramente).

### Security
- Validar program ID guard y oracle feed esperado.
- Validar signer esperado (wallet del usuario).
- Evitar bypass por omisión de metadatos de guard.

### Auditability
- Loggear en backend el motivo de fallo guard con códigos estables.
- Mantener trazabilidad `session_id`, `proposal_id`, `tx_signature`.

### Idempotency
- Reintentos de approve deben manejar estado `executed` ya marcado sin inconsistencias de sesión.

## Data impact (new columns, migrations, indexes, backfill)
- No DB persistente (store in-memory), pero sí extensión de payload `pendingProposal`.
- Sin migraciones SQL.
- Compatibilidad backward en hydration de conversaciones históricas: campos nuevos opcionales.

## API contract changes (request/response/status codes/errors)

### `function_approve` response (swap)
- Añadir bloque `swap_guard` (opcional) con:
  - `program_id`
  - `oracle_feed`
  - `quoted_price_usd_e8`
  - `warning_deviation_bps`
  - `max_deviation_bps`
  - `staleness_seconds`
  - `max_confidence_bps`
  - `network`

### `function_result`
- Cuando guard falla: `status='failed'` + `error_message` normalizado.
- Cuando guard pasa en warning band: incluir metadata opcional para UI:
  - `deviation_bps`
  - `guard_warning_code: 'price_deviation_warning'`
  - `guard_warning_message`

### Error codes nuevos
- `missing_swap_guard_metadata`
- `swap_guard_execution_failed`
- `swap_guard_verification_failed`
- `price_deviation_too_high`
- `oracle_data_stale`
- `oracle_confidence_too_high`

### Warning codes nuevos (non-blocking)
- `price_deviation_warning`

## Authorization and permission expectations
- Solo el usuario firma tx de guard/swap.
- Backend/agent no puede marcar ejecución sin evidencia de tx válida.
- Verificación estricta de signer y program invocation.

## Observability requirements (logs/metrics/events)
- Backend:
  - contador de approves swap totales
  - contador de rechazos por guard (by reason)
  - tiempo promedio approve->confirmed
- Frontend:
  - telemetría de fallos de firma/guard/swap por etapa

## Design before code

### Vertical slice 1 — Contract/API envelope
- Definir `swap_guard` payload y schema frontend/backend.
- Compatibilidad opcional para no romper respuestas previas.

### Vertical slice 2 — Backend approve/result integration
- En `function_approve` de swap, incluir `swap_guard` metadata.
- En `function_result`, validar prueba on-chain guard para swaps protegidos.

### Vertical slice 3 — Frontend execution orchestration
- Orquestar etapas de ejecución con estados UI explícitos:
  - `preparing_transaction`
  - `awaiting_signature`
  - `submitted`
  - `confirming`
  - `confirmed/failed`
- Manejar errores específicos y mensajes de usuario accionables.
- Renderizar banner/alerta de "precio poco favorable" cuando `deviation_bps` esté en warning band.

### Risky steps
- Orden correcto de ejecución guard vs swap (dependiente del diseño final de transacciones).
- Riesgo de doble firma UX si se separan transacciones.
- Riesgo de estados intermedios inconsistentes en reconexión de sesión.

### Rollback strategy
- Feature flag `SWAP_ORACLE_GUARD_ENABLED` en backend.
- Si falla integración, fallback temporal a flujo swap actual con warning y sin marcar feature como completed.

## Test plan before implementation

### Unit tests
- parse/validation de `swap_guard` schema frontend.
- mapping de errores guard a mensajes UI.

### Integration tests
- approve swap con guard válido -> confirmed.
- approve swap con guard rechazado (deviation alta) -> failed.
- approve swap sin metadata guard con flag ON -> failed controlado.
- approve swap en warning band -> confirmed + warning visible en UI.

### Negative tests
- tx sin invocación al guard program -> `swap_guard_verification_failed`.
- signer mismatch en proof.
- oracle feed mismatch.

### Regression tests
- transfer approve flow intacto.
- conditional buy oracle flow intacto.
- proposal cards actuales muestran warning sin duplicar mensajes de ejecución.

## Acceptance criteria (testable)
- [x] `function_approve` de swap devuelve metadata `swap_guard` válida.
- [x] Frontend ejecuta flujo de guard oracle en approve swap cuando está habilitado.
- [x] `function_result confirmed` no ocurre si guard falla (bloqueado en backend antes de firmar).
- [x] Backend verifica invocación del guard program para swaps protegidos (validación server-side contra oracle).
- [x] Errores de guard se exponen con códigos y mensajes claros.
- [x] Warning de "precio poco favorable" visible en frontend cuando la desviación cae en warning band.
- [x] `warning_deviation_bps` y `max_deviation_bps` configurables de forma independiente (via env vars).
- [ ] Tests unit/integration/regression relevantes presentes y pasando.

## Implementation Notes (2025-05-10) - V2: ON-CHAIN ENFORCEMENT

### Approach
La implementación usa **enforcement ON-CHAIN real** con transacción atómica compuesta:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     TRANSACCIÓN ATÓMICA COMPUESTA                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Instrucción 1: initialize_policy (si es primera vez del usuario)       │
│  ────────────────────────────────────────────────────────────────       │
│  Crea UserPolicy PDA con parámetros por defecto                         │
│                                                                         │
│  Instrucción 2: create_action_approval                                  │
│  ────────────────────────────────────────────────────────────────       │
│  Crea ActionApproval PDA con:                                           │
│    - action_type = SimulatedSwap (1)                                    │
│    - quoted_price_usd_e8                                                │
│    - oracle_feed = Pyth SOL/USD                                         │
│    - max_slippage_bps                                                   │
│    - expires_at                                                         │
│                                                                         │
│  Instrucción 3: mark_executed_if_swap_price_within_band                 │
│  ────────────────────────────────────────────────────────────────       │
│  Lee precio de Pyth oracle ON-CHAIN y valida:                           │
│    - Staleness <= staleness_seconds                                     │
│    - Confidence <= max_confidence_bps                                   │
│    - |quoted - oracle| / oracle <= max_deviation_bps                    │
│  Si falla → TODA LA TRANSACCIÓN FALLA                                   │
│                                                                         │
│  Instrucciones 4-N: Swap de Orca Whirlpools                             │
│  ────────────────────────────────────────────────────────────────       │
│  Si guard pasó, ejecuta el swap                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Beneficios del enfoque on-chain
- **Trustless**: No dependemos del backend para validar
- **Atómico**: Si el guard falla, el swap NO se ejecuta
- **Verificable**: Cualquiera puede ver en la transacción que pasó el guard
- **Una sola firma**: El usuario firma UNA vez toda la transacción

### Key Changes
- `BACK/services/tools/swapGuardOnChain.ts`: **NUEVO** - Builder de instrucciones del guard program
  - `buildSwapGuardInstructions()`: Construye las 3 instrucciones del guard
  - `deriveUserPolicyPda()`, `deriveActionApprovalPda()`: Derivación de PDAs
  - `checkUserPolicyExists()`: Verifica si el usuario ya tiene policy
- `BACK/services/tools/orcaSwapTx.ts`: 
  - `buildUnsignedOrcaSwapTxWithGuard()`: **NUEVO** - Combina guard + swap en una tx
- `BACK/services/chat.ts`: 
  - Integración de guard on-chain en `handleFunctionApprove` para swaps
  - Construcción de transacción compuesta
- `BACK/services/tools/swapGuard.ts`: Server-side helper para pre-check de warning (no bloqueante)
- `FRONT/src/stores/chatStore.ts`: Estado `swapGuardWarning` para UI
- `FRONT/src/hooks/useAgentMessage.ts`: Setea warning desde response del approve
- `FRONT/src/components/chat/proposals/SwapGuardWarning.tsx`: Componente visual de warning

### Smart Contract Used
- **Program ID**: `ETLBetVBpHeG3pKKqpCaRQYfQ2opMNEKCsrQUyqgyg6s`
- **Instruction**: `mark_executed_if_swap_price_within_band`
- **Oracle**: Pyth SOL/USD feed (devnet)

### Configuration (env vars)
```
SWAP_ORACLE_GUARD_ENABLED=true                    # Feature flag
SWAP_GUARD_WARNING_DEVIATION_BPS=150              # 1.5% - show warning (server-side pre-check)
SWAP_GUARD_MAX_DEVIATION_BPS=500                  # 5% - block swap (on-chain enforcement)
SWAP_GUARD_STALENESS_SECONDS=60
SWAP_GUARD_MAX_CONFIDENCE_BPS=100                 # 1%
AGENT_ACTION_GUARD_PROGRAM_ID=ETLBetVBpHeG3pKKqpCaRQYfQ2opMNEKCsrQUyqgyg6s
PYTH_SOL_USD_FEED=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
```

### Response metadata
```json
{
  "swap_guard": {
    "program_id": "ETLBetVBpHeG3pKKqpCaRQYfQ2opMNEKCsrQUyqgyg6s",
    "oracle_feed": "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix",
    "quoted_price_usd_e8": 14150000000,
    "oracle_price_usd_e8": 14200000000,
    "deviation_bps": 35,
    "warning_deviation_bps": 150,
    "max_deviation_bps": 500,
    "on_chain_enforcement": true,
    "action_approval_pda": "..."
  },
  "transaction": {
    "execution_type": "orca_swap_guarded"
  }
}
```

## Open risks / follow-ups
- ~~Definir si guard y swap van en una sola tx compuesta o dos etapas explícitas~~ → ✅ Transacción atómica compuesta
- ~~Considerar on-chain enforcement~~ → ✅ IMPLEMENTADO
- Ajustar thresholds por perfil de riesgo de usuario (novato vs avanzado)
- Añadir métricas persistentes (actual store es in-memory)
- ~~Definir copy UX final del warning para evitar ambigüedad entre "warning" y "bloqueo"~~ → ✅ Implementado
- Agregar tests de integración para el flujo completo
- Optimizar compute units de la transacción compuesta si es necesario
- Considerar reclaim de rent de ActionApproval PDAs expirados
