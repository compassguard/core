# Spec 001-chat: Backend Chat Agéntico (LangChain + LangGraph) con SSE

## Problem statement

Necesitamos un chat backend para la app (sin frontend nuevo en esta tarea), con streaming SSE y API key privada de OpenAI. Debe usar **LangChain** + **LangGraph** con flujo agéntico por estado/nodos: cargar contexto, llamar LLM, ejecutar tools, pedir aprobación humana (HITL) y resumir respuesta.

En esta iteración se implementa **solo una tool**: transferencia en lenguaje natural de una wallet a otra. No se ejecuta on-chain; solo se propone/prepara la acción.

## Scope in/out

### In scope
1. Endpoint `POST /api/chat` en Next route handler con streaming SSE.
2. Servicio backend en `BACK/services/chat.ts` implementado con:
   - cliente OpenAI vía LangChain,
   - grafo LangGraph con nodos: `context`, `agent`, `tools`, `proposal`, `summarize`,
   - salida en streaming SSE al cliente.
3. Tool funcional `transfer_to_wallet` definida con LangChain tools.
4. Enrutamiento automático por `llm.bindTools(...)` + condición de `tool_calls`.
5. HITL: pausa de flujo con `interrupt(...)` en nodo `proposal` y reanudación con `Command(resume=...)`.
6. Variables de entorno OpenAI documentadas.
7. Tests para contrato de input y validación de tool.
8. `sessionId` obligatorio por chat para aislar contexto de ejecución y asociar tool calls al usuario/sesión.

### Out of scope
1. Ejecutar transferencias on-chain.
2. Memoria persistente del grafo con checkpointer en Postgres.
3. Memoria de largo plazo (resúmenes/vectores en DB).
4. Persistencia de historial de chat fuera del hilo en memoria del request.
5. Autenticación/autorización por usuario.

## Functional requirements

1. `POST /api/chat` recibe `messages[]` y responde en streaming SSE (`text/event-stream`).
2. El backend usa `OPENAI_API_KEY` solo server-side.
3. El request debe incluir `sessionId` no vacío y estable por conversación.
3. El flujo se orquesta con LangGraph y estado compartido entre nodos:
   - `context`: prepara mensajes/sistema,
   - `agent`: invoca `ChatOpenAI` con `bindTools`,
   - `tools`: ejecuta `transfer_to_wallet` cuando existan `tool_calls`,
   - `proposal`: aplica HITL con `interrupt(...)` para aprobar/rechazar,
   - `summarize`: emite respuesta final para stream.
4. El nodo `agent` debe decidir cuándo llamar tool (no hardcodear invocación directa).
5. Si el request está mal formado, responder error JSON con status apropiado.
6. Si OpenAI falla, responder error controlado y trazable.
7. Si se requiere aprobación humana, el flujo debe pausar y devolver evento SSE con propuesta + instrucciones de resume.
8. El endpoint debe aceptar reanudación HITL con payload de `resume` para aprobar/rechazar propuesta.
9. La selección/ejecución de tools debe quedar asociada al `sessionId` para trazabilidad de qué usuario/sesión disparó cada acción propuesta.

## Non-functional requirements (latency, security, auditability, idempotency)

- **Latency**: respuesta incremental por SSE; no esperar respuesta completa para empezar a enviar chunks.
- **Security**: sin exposición de secrets; sanitización de errores upstream.
- **Auditability**: logs de error backend por nodo del grafo (`context/agent/tools/proposal/summarize`) y por transición.
- **Idempotency**: endpoint sin side-effects persistentes; repetir request no crea estado.

## Data impact (new columns, migrations, indexes, backfill)

Sin cambios de base de datos ni migraciones.

## API contract changes (request/response/status codes/errors)

### New endpoint
- `POST /api/chat`

### Request body (inicio de conversación)
```json
{
  "sessionId": "required-session-id",
  "threadId": "optional-thread-id",
  "messages": [
    { "role": "user", "content": "Transfiere 0.1 SOL desde <from> hacia <to>" }
  ]
}
```

### Request body (reanudar HITL)
```json
{
  "sessionId": "required-session-id",
  "threadId": "required-for-resume",
  "resume": {
    "approved": true,
    "reason": "optional"
  }
}
```

### Success
- `200` + `text/event-stream`

Eventos SSE esperados (mínimo):
- `event: token` (chunks de texto)
- `event: proposal` (cuando HITL pausa y pide aprobación)
- `event: done` (fin de stream)
- `event: error` (error controlado durante stream)

### Error responses
- `400`: `INVALID_JSON` | `MISSING_MESSAGES`
- `400`: `MISSING_SESSION_ID`
- `400`: `INVALID_RESUME_PAYLOAD`
- `503`: `OPENAI_API_KEY_NOT_CONFIGURED`
- `502`: `OPENAI_UPSTREAM_ERROR`

## Authorization and permission expectations

No auth en esta iteración (solo entorno controlado). En siguiente fase, exigir auth antes de habilitar tools sensibles y antes de permitir `resume` de HITL.

`sessionId` no reemplaza autenticación: en esta fase solo segmenta contexto y trazabilidad técnica. En fase siguiente debe validarse contra identidad/autorización real.

## Observability requirements (logs/metrics/events)

1. Logs de errores por nodo del grafo.
2. Log de `tool_calls` con nombre de tool y resultado (`approved/rejected/prepared`) sin exponer secretos.
2. Contadores mínimos recomendados:
   - `chat_requests_total`
   - `chat_stream_errors_total`
   - `chat_upstream_errors_total`
   - `chat_hitl_interrupt_total`
   - `chat_hitl_resume_total`
   - `chat_tool_transfer_total`

## Design (vertical slices, risky steps, rollback)

### Slice 1: contrato API y validación de request
- Archivo: `app/api/chat/route.ts`
- Responsabilidad: parsear JSON, validar `sessionId` + `messages`/`resume`, delegar al servicio.

### Slice 2: servicio LangChain + LangGraph
- Archivo: `BACK/services/chat.ts`
- Responsabilidad: construir state graph, registrar tools, manejar interrupt/resume, exponer SSE y enrutar estado por `sessionId`.

### Slice 2.1: almacenamiento temporal de sesión (dev)
- Archivo sugerido: `BACK/services/chatSessionStore.ts`
- Responsabilidad: mapear `sessionId -> estado temporal del hilo/propuesta pendiente` en memoria para continuidad básica sin DB.

### Slice 3: tool de transferencia
- Archivo: `BACK/services/tools/transfer.ts` (o inline temporal en `chat.ts`)
- Responsabilidad: validar `fromWallet`, `toWallet`, `amount`, devolver propuesta preparada.

### Slice 4: tests backend
- Archivo: `BACK/services/__tests__/chat.test.ts`
- Casos: validación de request shape, validación de tool y negativos de resume.

### Riesgos explícitos
1. Compatibilidad de versiones LangChain/LangGraph con runtime de Next.
2. Adaptación de streaming SSE (eventos custom) entre LangGraph y route handler.
3. Manejo consistente de `interrupt/resume` sin checkpointer persistente.
4. Pérdida de contexto entre requests de resume si no hay estrategia temporal por `threadId`.
5. Colisiones o suplantación de `sessionId` en ausencia de auth fuerte.

### Rollback strategy
1. Eliminar/rollback `app/api/chat/route.ts`, `BACK/services/chat.ts` y módulos de tools asociados.
2. Sin impacto en DB/contratos on-chain.
3. Mantener endpoint fuera de despliegue hasta validar estabilidad.

## Test plan mapped to requirements

1. **Unit** (R5): validación de `messages[]` y de `resume` payload.
2. **Unit** (R3): validación de `sessionId` (presente, string, no vacío).
3. **Unit** (R4, R9): validación de arguments de `transfer_to_wallet` y asociación de resultado a `sessionId`.
4. **Integration/manual** (R1, R3, R7): `POST /api/chat` entrega SSE con `token/proposal/done`.
5. **Integration/manual** (R8, R9): reanudación con mismo `sessionId` + `resume.approved=true/false` continúa/termina flujo correcto.
6. **Negative** (R5, R6): `INVALID_JSON`, `MISSING_SESSION_ID`, `MISSING_MESSAGES`, `INVALID_RESUME_PAYLOAD`, error upstream controlado.

## Acceptance criteria (testable)

- [x] Existe `POST /api/chat` con respuesta streaming SSE (`token/proposal/done/error`).
- [x] Implementación usa LangChain + LangGraph (sin fetch directo a OpenAI).
- [x] `sessionId` es obligatorio y segmenta correctamente estado/ejecución por conversación.
- [x] `OPENAI_API_KEY` solo backend.
- [x] Tool `transfer_to_wallet` funciona desde lenguaje natural vía `bindTools` y routing por `tool_calls`.
- [x] HITL implementado con `interrupt(...)` y reanudación vía `Command(resume=...)`.
- [x] Errores documentados retornan códigos esperados.
- [x] Tests de validación de request/tool/resume existen y pasan.
