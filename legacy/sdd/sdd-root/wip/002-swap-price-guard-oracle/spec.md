# 002 — Swap Price Guard Oracle (Pyth) for Agent-Action-Guard

## Problem statement
Actualmente el flujo de swap puede ejecutar una transacción firmada por el usuario sin una verificación on-chain de que el precio implícito del swap sea razonable contra un oracle confiable. Esto deja exposición a:
- rutas degradadas o manipuladas,
- cotizaciones desfasadas,
- errores de cálculo del agente/backend/frontend,
- slippage efectivo excesivo.

Necesitamos una policy on-chain que compare el precio implícito del swap contra Pyth y rechace ejecución si la desviación supera un umbral permitido.

## Discovery

### Business goal
- Proteger al usuario (especialmente principiante) de swaps a precio anómalo mediante enforcement on-chain.
- Mantener patrón "agent proposes, user signs" sin ejecución autónoma del agente.

### Non-goals
- No implementar agregador de rutas on-chain.
- No reemplazar validaciones off-chain (risk score, reputación, etc.).
- No cubrir todos los pares en esta primera iteración (MVP enfocado en SOL/USDC).

### Current behavior
- `agent-action-guard` ya soporta approvals, slippage cap y validación oracle para condición de compra (`mark_executed_if_price_below`).
- No existe instrucción dedicada para validar desviación del precio de swap (`quoted_price` vs `oracle_price`) antes de marcar ejecución.

### Constraints
- Devnet first.
- Compatibilidad con arquitectura actual: proposal en backend, firma en wallet, resultado reportado a backend.
- Costo computacional moderado (lectura de cuenta Pyth + aritmética segura).

### Affected modules / ownership boundaries
- On-chain:
  - `back/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs`
- Backend:
  - `back/services/chat.ts` (function_approve / function_result integration)
  - `back/services/onchainApproval.ts` o módulo de verificación equivalente
- Frontend:
  - Hook de approve/execute para enviar la instrucción correcta y cuentas oracle

### Data-model impact and migration risks
- Cambios en cuentas de estado de `ActionApproval` para incluir parámetros de guard de desviación (si se decide persistirlos por approval).
- Riesgo: cambio de tamaño de cuenta Anchor implica recalcular `space` y manejar compatibilidad con approvals antiguos.
- Mitigación: introducir campos opcionales/versionados o crear una nueva cuenta/flujo para approvals de swap guardado.

### API consumers and backward compatibility
- Consumidores:
  - Frontend (approve flow)
  - Backend chat API (`function_approve`, `function_result`)
- Requisito de compatibilidad:
  - Flujos existentes de transfer/conditional buy no deben romperse.
  - Si no hay parámetros de oracle deviation para una acción, mantener comportamiento previo para tipos no-swap.

## Scope in/out

### In scope
- Nueva validación on-chain de desviación de precio de swap usando Pyth.
- Integración end-to-end para swap proposal -> approve -> on-chain guard check -> executed.
- Configuración de parámetros de seguridad por policy/approval:
  - `max_deviation_bps`
  - `staleness_seconds`
  - `max_confidence_bps`

### Out of scope
- Multi-oracle aggregation.
- Auto-retry inteligente de rutas de swap.
- Mainnet rollout (solo devnet en esta fase).

## Functional requirements
1. El programa debe exponer una instrucción para marcar aprobación como ejecutada solo si la desviación de precio de swap está dentro de un umbral permitido.
2. La instrucción debe:
   - validar ownership/autorización del usuario,
   - validar que la approval esté activa (no expirada/revocada/ejecutada),
   - validar que el oracle feed recibido coincide con el esperado,
   - leer precio y confianza de Pyth,
   - validar staleness,
   - calcular desviación en bps entre `quoted_price_e8` y `oracle_price_e8`.
3. Si `deviation_bps > max_deviation_bps`, rechazar ejecución.
4. Si `confidence_bps > max_confidence_bps`, rechazar ejecución.
5. Si pasa validaciones, marcar `approval.executed = true`.
6. El backend/frontend debe usar esta instrucción para swaps protegidos (MVP SOL/USDC).

## Non-functional requirements

### Latency
- La verificación on-chain no debe agregar más de una instrucción adicional en el flujo de ejecución de swap.

### Security
- Aritmética segura (evitar overflow/underflow).
- Rechazo de oracle price inválido (<= 0).
- Rechazo de oracle stale/confidence alta.
- Protección contra replay vía estado `executed/revoked/expired` existente.

### Auditability
- Errores explícitos Anchor para cada motivo de rechazo (price deviation, stale, confidence, mismatch).
- Registro de eventos/logs suficientes para diagnóstico.

### Idempotency
- Reintento de la misma aprobación ya ejecutada debe fallar con error determinístico (`AlreadyExecuted`).

## Data impact (new columns, migrations, indexes, backfill)
- On-chain account (`ActionApproval`):
  - Opción A (preferida para trazabilidad): agregar campos
    - `quoted_price_e8: u64` (opcional según tipo)
    - `max_deviation_bps: u16`
  - Opción B: pasar `quoted_price_e8` como argumento en ejecución y solo persistir `max_deviation_bps` en policy.
- Migración:
  - Requiere actualización de `space` del account si se agregan campos.
  - No aplica backfill de datos antiguos para devnet MVP.

## API contract changes (request/response/status codes/errors)

### On-chain instruction (new)
- `mark_executed_if_swap_price_within_band(...)`
  - Inputs esperados:
    - `quoted_price_e8: u64`
    - `staleness_seconds: u64`
    - `max_confidence_bps: u64`
  - Cuentas:
    - `user`
    - `action_approval`
    - `oracle_price_feed`

### Backend/API
- `function_approve` para swaps debe devolver datos necesarios para ejecutar guard instruction (oracle feed, quoted price normalizado, límites aplicables) o referencia a ellos.
- Errores backend mapeados desde on-chain:
  - `oracle_data_stale`
  - `oracle_confidence_too_high`
  - `price_deviation_too_high`
  - `oracle_feed_mismatch`

## Authorization and permission expectations
- Solo el usuario dueño de la approval puede ejecutar la instrucción de marcado.
- El agente/backend no puede marcar ejecución sin firma del usuario.
- El oracle feed debe estar fijado por policy/approval para evitar feed swapping.

## Observability requirements (logs/metrics/events)
- On-chain:
  - eventos o logs con `oracle_price_e8`, `quoted_price_e8`, `deviation_bps` (sin exponer secretos).
- Backend:
  - métricas de rechazo por motivo (`price_deviation`, `stale`, `confidence`).
  - trazabilidad por `session_id` y `tx_signature`.

## Design before code

### Vertical slice 1 — Program core (guard instruction)
- Añadir nueva instrucción en `agent-action-guard` para validación de banda de precio swap.
- Definir errores nuevos Anchor.
- Añadir tests unitarios on-chain para:
  - within band (success),
  - above band (reject),
  - stale/confidence/mismatch (reject).

### Vertical slice 2 — Backend integration
- Ajustar `function_approve` de swap para incluir metadatos necesarios (quoted price/oracle feed/params guard).
- Ajustar verificación de `function_result` para aceptar/rechazar según resultado on-chain.

### Vertical slice 3 — Frontend execution path
- Al aprobar swap protegido, invocar instrucción guard antes de cerrar estado como success.
- Mostrar error específico al usuario cuando guard rechaza.

### Risky steps
- Orden de migración de account size en Anchor (riesgo de incompatibilidad con approvals previos).
- Normalización de decimales (`e8`) y cálculo de desviación (riesgo de rounding errors).
- Dependencia externa de calidad del feed devnet.

### Rollback strategy
- Mantener feature-flag para activar guard solo en swaps nuevos.
- Si hay fallo crítico, desactivar path de guard y volver a flujo previo (sin borrar programa desplegado), mientras se preserva transfer/conditional buy.

## Test plan before implementation

### Requirement mapping
1. **Unit tests (program)**
   - cálculo correcto de `deviation_bps`.
   - rechazo por desviación alta.
   - rechazo por staleness.
   - rechazo por confianza alta.
   - rechazo por feed mismatch.

2. **Integration tests (backend + on-chain local/devnet)**
   - approve swap con precio válido -> success.
   - approve swap con precio fuera de banda -> failed con error esperado.

3. **Negative tests**
   - ejecución por wallet no dueña.
   - approval expirada/revocada/ya ejecutada.

4. **Regression tests**
   - transfer flow sin cambios.
   - conditional buy oracle flow existente sin regresión.

## Acceptance criteria (testable)
- [ ] Existe instrucción on-chain de swap price guard usando Pyth.
- [ ] La instrucción rechaza swaps cuando `deviation_bps > max_deviation_bps`.
- [ ] La instrucción rechaza oracle stale o con confidence fuera de umbral.
- [ ] El flujo approve swap en frontend/backend consume la nueva validación.
- [ ] Los errores de rechazo se muestran de forma clara en UI/API.
- [ ] Tests unit/integration/negative/regression implementados y pasando.
- [ ] Documentación de parámetros devnet (feed, thresholds) actualizada.

## Open risks / follow-ups
- Confirmar disponibilidad y calidad del feed SOL/USD en devnet en todo momento.
- Definir política por defecto para usuarios nuevos (ej. `max_deviation_bps=300`, `max_confidence_bps=100`, `staleness=60s`).
- Evaluar mover parsing manual de Pyth a librería oficial si impacta mantenibilidad.
