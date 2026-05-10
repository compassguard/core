# 001 - Unificar Contrato de Chat (SSE + JSON Approval)

## Problem Statement

Actualmente existen dos contratos de chat incompatibles:
- **Frontend** (`/api/agent/message`): Mock con JSON síncrono
- **Backend** (`/api/chat`): LLM real con SSE streaming

El frontend no puede consumir el backend real porque:
1. El backend usa SSE, el frontend espera JSON
2. Los nombres de tools difieren (`transfer` vs `transfer_to_wallet`)
3. Los parámetros de transfer difieren
4. El flujo de aprobación es diferente

## Scope

### In Scope
- Adaptar frontend para consumir SSE streaming del backend
- Unificar contrato de request/response entre front y back
- Unificar tool `transfer` con parámetros consistentes
- Flujo de aprobación: SSE para mensajes LLM + JSON separado para decisiones

### Out of Scope
- Implementar tools `swap` y `stake` (solo `transfer` por ahora)
- Cambios en la UI de componentes (solo wiring)
- Ejecución real on-chain (solo preparación)

## Functional Requirements

### FR-1: Request Contract Unificado

```typescript
// POST /api/chat
type ChatRequest =
  | {
      type: 'user_message';
      content: string;
      session_id?: string;           // Opcional en primer mensaje, backend genera si no existe
      user_address?: string;          // Wallet conectada del usuario
      user_threshold_usd?: number;    // Umbral para auto-confirm
    }
  | {
      type: 'function_approve';
      session_id: string;             // Requerido para identificar propuesta
    }
  | {
      type: 'function_reject';
      session_id: string;
      reason?: string;                // Opcional: razón del rechazo
    };
```

### FR-2: Response - SSE Stream para Mensajes

Para `user_message`, el backend responde con SSE stream:

```
event: session
data: {"session_id": "sess_abc123"}

event: token
data: {"content": "Entendido, voy a preparar"}

event: token  
data: {"content": " la transferencia..."}

event: proposal
data: {
  "type": "function_call",
  "function": {
    "name": "transfer",
    "params": {
      "amount": 0.5,
      "token": "SOL",
      "recipient": "7vW4...1111"
    }
  },
  "display": {
    "summary": "Enviar 0.5 SOL a 7vW4...1111",
    "fee_usd": 0.01
  },
  "risk": {
    "score": 42,
    "level": "medium",
    "reasons": ["Dirección nueva"]
  }
}

event: done
data: {"session_id": "sess_abc123", "awaiting_approval": true}
```

### FR-3: Response - JSON para Approve/Reject

Para `function_approve` y `function_reject`, respuesta JSON simple:

```typescript
// POST /api/chat con type: 'function_approve'
// Response (JSON):
{
  "messages": [
    {
      "type": "text",
      "content": "Transferencia ejecutada exitosamente.",
      "execute": {
        "status": "success",
        "tx_hash": "5xYdemo..."
      },
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}

// POST /api/chat con type: 'function_reject'
// Response (JSON):
{
  "messages": [
    {
      "type": "text", 
      "content": "Entendido, cancelé la transferencia.",
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### FR-4: Tool `transfer` Unificada

```typescript
type TransferParams = {
  amount: number;      // Cantidad a transferir
  token: string;       // Símbolo del token (e.g., "SOL", "USDC")
  recipient: string;   // Dirección destino
  memo?: string;       // Memo opcional
};
```

- `fromWallet` NO se incluye en params - se obtiene de `user_address` en el request o de la sesión.

### FR-5: Session Management

- Backend genera `session_id` si no se provee en primer mensaje
- `session_id` se devuelve en evento `session` del SSE
- Frontend debe almacenar y reenviar `session_id` en mensajes subsiguientes
- Propuestas pendientes se asocian a `session_id`

### FR-6: Tipos de Mensajes del Agente

```typescript
type AgentMessage =
  | {
      type: 'text';
      content: string;
      execute?: {
        status: 'success' | 'failed';
        tx_hash?: string;
        error?: string;
      };
      timestamp: string;
    }
  | {
      type: 'function_call';
      function: {
        name: 'transfer';  // Solo transfer por ahora
        params: TransferParams;
      };
      display: {
        summary: string;
        fee_usd?: number;
        provider?: string;
      };
      risk: {
        score: number;
        level: 'low' | 'medium' | 'critical';
        reasons?: string[];
      };
      timestamp: string;
    }
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: string;
    };
```

## Non-Functional Requirements

### NFR-1: Latency
- Primer token SSE debe llegar en < 2s después del request
- Respuestas JSON (approve/reject) en < 500ms

### NFR-2: Security
- `session_id` debe ser opaco y no adivinable (UUID v4 o similar)
- `user_address` se valida como dirección Solana válida

### NFR-3: Idempotency
- `function_approve` en sesión sin propuesta pendiente retorna error
- Múltiples `function_approve` consecutivos retornan el mismo resultado

### NFR-4: Error Handling
- Errores SSE se envían como `event: error` antes de cerrar stream
- Errores JSON usan estructura estándar `{ error: { code, message } }`

## Data Impact

### Cambios en Session Store (Backend)
- Agregar `user_address` a la sesión
- Mantener estructura existente de `pendingProposal`

### No hay cambios de DB/migrations
- Sessions son in-memory (ya existente)

## API Contract Changes

### Endpoint Unificado: `POST /api/chat`

Reemplaza tanto `/api/agent/message` (mock) como `/api/chat` (actual).

| Request Type | Response Type | Descripción |
|--------------|---------------|-------------|
| `user_message` | SSE Stream | Mensajes del LLM con posible proposal |
| `function_approve` | JSON | Confirma y ejecuta propuesta pendiente |
| `function_reject` | JSON | Cancela propuesta pendiente |

### Deprecación
- `/api/agent/message` se elimina (era mock)

## Authorization & Permissions

- No hay auth por ahora (hackathon)
- `user_address` se confía del cliente (futuro: verificar firma)

## Observability

### Logs
- `[chat] New session: {session_id}`
- `[chat] User message: {session_id} - {content_preview}`
- `[chat] Proposal created: {session_id} - transfer {amount} {token}`
- `[chat] Proposal approved/rejected: {session_id}`

### Metrics (futuro)
- `chat_messages_total`
- `chat_proposals_created_total`
- `chat_proposals_approved_total`

## Acceptance Criteria

### AC-1: SSE Streaming funciona
- [ ] Usuario envía mensaje, frontend recibe tokens via SSE
- [ ] Tokens se acumulan y muestran en tiempo real en UI

### AC-2: Proposals funcionan
- [ ] Cuando LLM detecta intención de transfer, envía evento `proposal`
- [ ] Frontend muestra ProposalCard con datos del proposal
- [ ] UI bloquea input mientras hay proposal pendiente

### AC-3: Approve funciona
- [ ] Usuario clickea "Aprobar", frontend envía `function_approve`
- [ ] Backend responde JSON con resultado de ejecución
- [ ] UI muestra resultado (success/failed)

### AC-4: Reject funciona
- [ ] Usuario clickea "Rechazar", frontend envía `function_reject`
- [ ] Backend responde JSON confirmando cancelación
- [ ] UI limpia proposal y permite nuevo input

### AC-5: Session persistence
- [ ] Múltiples mensajes en misma sesión mantienen contexto
- [ ] `session_id` se preserva entre requests

### AC-6: Wallet address se envía
- [ ] Frontend incluye `user_address` del wallet conectado
- [ ] Backend usa esa dirección como `fromWallet` en transfers

## Test Plan

### Unit Tests
- [ ] `normalizeMessages` parsea correctamente
- [ ] Session store: create, get, update, clear
- [ ] Transfer tool: genera params correctos

### Integration Tests
- [ ] POST user_message → SSE stream con tokens
- [ ] POST user_message con intención transfer → SSE con proposal
- [ ] POST function_approve con session válida → JSON success
- [ ] POST function_approve sin session → JSON error
- [ ] POST function_reject → JSON confirmation

### E2E Tests (manual)
- [ ] Flujo completo: conectar wallet → enviar "transfer 0.1 SOL to X" → aprobar → ver resultado

## Implementation Slices

### Slice 1: Backend - Unificar contrato (2h)
**Files:**
- `BACK/services/chat.ts` - Adaptar a nuevo contrato
- `app/api/chat/route.ts` - Ya existe, ajustar validación
- Eliminar `app/api/agent/message/route.ts`

**Cambios:**
1. Renombrar tool `transfer_to_wallet` → `transfer`
2. Adaptar params de transfer al formato del front
3. Para `function_approve`/`function_reject`: responder JSON (no SSE)
4. Extraer `user_address` del request y guardarlo en sesión

### Slice 2: Frontend - Cliente SSE (2h)
**Files:**
- `FRONT/src/lib/api/client.ts` - Agregar `streamChat()` 
- `FRONT/src/lib/api/schemas.ts` - Agregar schemas SSE
- `FRONT/src/hooks/useAgentMessage.ts` - Refactor para SSE

**Cambios:**
1. Crear función `streamChat()` que consuma SSE
2. Parsear eventos: `session`, `token`, `proposal`, `done`, `error`
3. Mantener `postApprove()` y `postReject()` como JSON simple
4. Acumular tokens en estado

### Slice 3: Frontend - Integrar con Store (1h)
**Files:**
- `FRONT/src/stores/chatStore.ts` - Agregar `sessionId`, acciones para tokens
- `FRONT/src/hooks/useAgentMessage.ts` - Usar nuevo cliente

**Cambios:**
1. Agregar `sessionId` al store
2. Agregar action `appendToken(content: string)`
3. Conectar hook con wallet address via `useWallet()`

### Slice 4: Testing & Cleanup (1h)
- Actualizar tests existentes
- Verificar build
- Probar flujo E2E manual

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SSE no soportado en algunos browsers | Bajo | SSE tiene soporte universal moderno |
| Azure Responses API cambia formato | Medio | Abstraer parsing en función dedicada |
| Session memory leak | Bajo | Agregar TTL a sesiones (futuro) |

## Open Questions / Follow-ups

1. **Firma de transacciones**: ¿Cómo se firma realmente con Phantom SDK? (fuera de scope actual)
2. **Persistencia de sesiones**: ¿Redis/DB para producción? (fuera de scope)
3. **Rate limiting**: Agregar en producción

---

**Status:** Implemented  
**Author:** Claude  
**Created:** 2024-05-09  
**Last Updated:** 2024-05-09
**Implemented:** 2024-05-09

## Implementation Notes

### Files Changed

**Backend:**
- `BACK/services/chat.ts` - Unified chat service with SSE for user_message, JSON for approve/reject
- `BACK/services/chatSessionStore.ts` - Added `userAddress` to session state
- `BACK/services/tools/transfer.ts` - Unified transfer tool with new params format
- `app/api/chat/route.ts` - Updated route handler
- Deleted: `app/api/agent/message/route.ts` (mock endpoint)

**Frontend:**
- `FRONT/src/lib/api/client.ts` - Added `streamChat()`, `postApprove()`, `postReject()`
- `FRONT/src/lib/api/schemas.ts` - Added `SSEProposalSchema`
- `FRONT/src/stores/chatStore.ts` - Added `sessionId`, streaming actions
- `FRONT/src/hooks/useAgentMessage.ts` - Refactored to use SSE streaming
- `FRONT/src/types/api.ts` - Updated `AgentMessageRequest` type

**Tests:**
- `BACK/services/__tests__/chat.test.ts` - Updated for new transfer API
