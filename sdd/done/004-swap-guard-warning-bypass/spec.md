# 004 - Swap Guard Warning con Bypass Opcional

## Problem Statement

Actualmente el swap con guard on-chain tiene comportamiento binario:
- Si la desviación de precio está dentro del umbral → TX pasa
- Si la desviación supera el umbral → TX falla, no hay forma de ejecutar

El usuario no tiene opción de aceptar el riesgo y ejecutar igual cuando el guard rechaza la transacción. Esto es demasiado restrictivo para algunos casos de uso legítimos (ej: mercados volátiles, tokens con poca liquidez).

## Scope

### In Scope
- Detectar fallo del guard on-chain en simulación antes de pedir firma
- Mostrar warning claro al usuario con información de desviación
- Permitir al usuario elegir entre cancelar o ejecutar sin protección
- Construir TX alternativa sin guard si el usuario acepta el riesgo
- Logging de decisiones para auditoría

### Out of Scope
- Modificaciones al smart contract
- Cambios en los umbrales de desviación
- Nuevos tipos de validaciones

## Functional Requirements

### FR-1: Detección de fallo en simulación
- El backend simula la TX completa (guard + swap) antes de enviarla al usuario
- Si la simulación falla por `PriceDeviationTooHigh`, capturar el error
- Extraer información de desviación del error/logs si es posible

### FR-2: Respuesta con warning y opciones
- En lugar de devolver error, devolver estado `guard_rejected_awaiting_bypass`
- Incluir en la respuesta:
  - `swap_guard_rejected: true`
  - `deviation_bps: number` (desviación detectada)
  - `oracle_price_usd: number` (precio del oráculo)
  - `quoted_price_usd: number` (precio cotizado)
  - `warning_message: string` (mensaje explicativo)
  - `can_bypass: true`

### FR-3: Endpoint/flujo de bypass
- El usuario puede responder con `function_approve` + `accept_risk: true`
- Backend valida que existe propuesta en estado `guard_rejected_awaiting_bypass`
- Backend construye nueva TX **sin** instrucciones del guard (solo Orca swap)
- Envía TX sin guard al usuario para firma

### FR-4: UI de warning
- Frontend muestra modal/alerta con:
  - Icono de advertencia
  - Mensaje: "El precio del swap difiere X% del precio de mercado"
  - Explicación: "Esto podría indicar manipulación de precio o condiciones desfavorables"
  - Botón "Cancelar" (primario)
  - Botón "Ejecutar igual (sin protección)" (secundario, rojo/warning)

### FR-5: Logging
- Registrar cuando el guard rechaza una TX
- Registrar cuando el usuario elige bypass
- Incluir: session_id, user_address, deviation_bps, timestamp

## Non-Functional Requirements

### NFR-1: Latencia
- La simulación no debe agregar más de 500ms al flujo normal

### NFR-2: Seguridad
- El bypass solo funciona para swaps donde el guard falló por desviación
- No se puede usar bypass para otros tipos de errores

### NFR-3: Auditabilidad
- Todas las decisiones de bypass quedan registradas en logs del backend

## Data Impact

### Session Store
Agregar nuevo estado de propuesta:
```typescript
type ProposalState = 
  | 'awaiting_approval'
  | 'guard_rejected_awaiting_bypass'  // NUEVO
  | 'preparing_transaction'
  | 'awaiting_signature'
  | ...
```

Agregar campos en `PendingProposal`:
```typescript
interface PendingProposal {
  // ... campos existentes
  guardRejected?: boolean;
  guardRejectionReason?: string;
  deviationBps?: number;
  oraclePriceUsd?: number;
  quotedPriceUsd?: number;
}
```

## API Contract Changes

### POST /api/chat - function_approve response (guard rejected)

**Nuevo response cuando guard rechaza:**
```json
{
  "messages": [{
    "type": "alert",
    "severity": "warning",
    "content": "El guard on-chain rechazó esta transacción porque el precio difiere 8.5% del oráculo."
  }],
  "proposal_state": {
    "state": "guard_rejected_awaiting_bypass",
    "expires_at": "2024-01-01T00:00:00Z"
  },
  "guard_rejection": {
    "reason": "PriceDeviationTooHigh",
    "deviation_bps": 850,
    "max_allowed_bps": 500,
    "oracle_price_usd": 140.00,
    "quoted_price_usd": 152.00,
    "can_bypass": true,
    "warning_message": "El precio del swap difiere significativamente del precio de mercado. Ejecutar sin protección podría resultar en pérdidas."
  }
}
```

### POST /api/chat - function_approve con bypass

**Request:**
```json
{
  "type": "function_approve",
  "session_id": "sess_xxx",
  "accept_risk": true
}
```

**Response:**
```json
{
  "messages": [{
    "type": "text",
    "content": "Swap preparado SIN protección de precio. Firma en tu wallet."
  }],
  "proposal_state": {
    "state": "awaiting_signature",
    "expires_at": "..."
  },
  "transaction": {
    "format": "base64_versioned_transaction",
    "unsigned_tx_base64": "...",
    "execution_type": "orca_swap_unguarded"
  },
  "risk_accepted": true
}
```

## Authorization

- El bypass solo lo puede solicitar el mismo usuario que inició el swap
- Se valida que `session.userAddress` coincida con la propuesta original

## Observability

### Logs
```
[swapGuard] Guard rejected: session=sess_xxx, deviation=850bps, max=500bps
[swapGuard] User accepted bypass: session=sess_xxx, user=8QZc...
[swapGuard] Unguarded swap executed: session=sess_xxx, tx=5abc...
```

### Métricas (futuro)
- `swap_guard_rejections_total`
- `swap_guard_bypass_accepted_total`
- `swap_guard_bypass_rejected_total`

## Acceptance Criteria

- [ ] AC-1: Cuando el guard rechaza por desviación, el usuario ve un warning con la información de desviación
- [ ] AC-2: El usuario puede elegir "Cancelar" y no se ejecuta nada
- [ ] AC-3: El usuario puede elegir "Ejecutar igual" y se construye TX sin guard
- [ ] AC-4: La TX sin guard se ejecuta correctamente en Orca
- [ ] AC-5: Los logs registran tanto el rechazo como la decisión del usuario
- [ ] AC-6: Si el guard falla por otro motivo (no desviación), NO se ofrece bypass

## Implementation Plan

### Slice 1: Backend - Detección y response (1.5 hrs)
1. Modificar `parseSimulationError` para detectar `PriceDeviationTooHigh`
2. Agregar estado `guard_rejected_awaiting_bypass` en `chatSessionStore.ts`
3. Modificar flujo en `chat.ts` para devolver `guard_rejection` en lugar de error
4. Extraer info de desviación de los logs de simulación

### Slice 2: Backend - Bypass flow (1 hr)
1. Modificar `handleFunctionApprove` para aceptar `accept_risk: boolean`
2. Si `accept_risk=true` y estado es `guard_rejected_awaiting_bypass`:
   - Construir TX con `buildUnsignedOrcaSwapTx` (sin guard)
   - Actualizar estado a `awaiting_signature`
3. Agregar logging de bypass

### Slice 3: Frontend - UI de warning (1 hr)
1. Detectar response con `guard_rejection` en `useAgentMessage`
2. Mostrar componente `SwapGuardBypassWarning` con opciones
3. Implementar botón "Ejecutar igual" que envía `function_approve` con `accept_risk: true`

### Slice 4: Testing (30 min)
1. Test manual con `SWAP_GUARD_MAX_DEVIATION_BPS=1` para forzar rechazo
2. Verificar flujo completo: rechazo → warning → bypass → ejecución
3. Verificar que cancelar funciona correctamente

## Rollback Strategy

- Feature flag `SWAP_GUARD_BYPASS_ENABLED=true|false`
- Si está en `false`, comportamiento actual (error sin opción de bypass)

## Open Risks / Follow-ups

1. **Riesgo de abuso**: Usuarios podrían siempre elegir bypass. Mitigación: logging + posibles límites futuros
2. **UX de doble confirmación**: El warning debe ser lo suficientemente claro para que el usuario entienda el riesgo
3. **Extracción de desviación**: Los logs de simulación pueden no tener el valor exacto de desviación, podría requerir cálculo adicional
