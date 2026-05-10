# Technical Spec: Backend Chat Session History

## Arquitectura propuesta

La sesion de chat pasa a ser backend-first:

- `BACK/services/chatSessionStore.ts` mantiene el estado completo de la sesion en memoria con TTL.
- `BACK/services/chat.ts` deja de ser efectivamente stateless y usa el transcript de la sesion para construir el input del LLM y para registrar eventos de la conversacion.
- `app/api/chat/route.ts` sigue exponiendo un unico endpoint `POST /api/chat`, ahora con un tipo adicional de lectura de historial.
- `FRONT/src/stores/chatStore.ts` se simplifica para manejar estado UI en memoria y persistir solo `session_id` activo.
- `FRONT/src/hooks/useAgentMessage.ts` rehidrata la sesion desde backend al montar o al detectar un `session_id` persistido.

## Componentes

### Backend session store

Extender `SessionState` para que el transcript almacenado sea util para dos fines:

- contexto LLM
- rehidratacion de UI

Se recomienda separar el modelo interno de contexto del modelo serializable para cliente.

Ejemplo de shape propuesto:

```ts
type SessionTranscriptEntry =
  | { id: string; role: 'user'; kind: 'text'; content: string; timestamp: string }
  | { id: string; role: 'assistant'; kind: 'text'; content: string; timestamp: string }
  | { id: string; role: 'assistant'; kind: 'proposal'; proposal: AgentFunctionCallMessage; timestamp: string }
  | { id: string; role: 'system'; kind: 'result'; result: SessionResultPayload; timestamp: string };
```

Notas:

- `messages: BaseMessage[]` puede seguir existiendo si simplifica integración con LangChain/Azure Responses.
- Si se mantienen dos representaciones, debe haber una unica API de append/update para evitar divergencia.
- No se debe guardar una transaccion firmada ni secretos del usuario en el transcript.

### Chat service

`BACK/services/chat.ts` debe:

1. Resolver o crear sesion.
2. Agregar el mensaje de usuario al transcript antes de invocar al LLM.
3. Construir `conversationInput` con historial previo relevante de la sesion.
4. Durante el stream, acumular la respuesta final del asistente.
5. Cuando el stream termina:
   - persistir respuesta de texto si hubo texto final
   - persistir propuesta si hubo `function_call`
   - actualizar `pendingProposal` si corresponde
6. En `function_approve`, `function_reject` y `function_result`, persistir el evento resultante en transcript y en `pendingProposal`.

### API contract

Se agrega un request type nuevo al endpoint actual:

```ts
type ChatRequest =
  | { type: 'user_message'; content: string; session_id?: string; user_address?: string; user_threshold_usd?: number }
  | { type: 'get_history'; session_id: string }
  | { type: 'function_approve'; session_id: string }
  | { type: 'function_result'; session_id: string; tx_signature: string; status: 'submitted' | 'confirmed' | 'failed'; error_message?: string }
  | { type: 'function_reject'; session_id: string; reason?: string };
```

Respuesta sugerida para `get_history`:

```ts
type GetHistoryResponse = {
  session_id: string;
  user_address: string | null;
  updated_at: string;
  messages: AgentMessage[];
  pending_proposal: AgentFunctionCallMessage | null;
};
```

Reglas:

- Si la sesion no existe o expiro: `404` con `error.code = 'session_not_found'`.
- `messages` debe estar listo para rehidratar la UI sin reconstruccion local desde `localStorage`.
- `pending_proposal` debe ser coherente con el transcript devuelto.

### Frontend store and hydration

`FRONT/src/stores/chatStore.ts` debe pasar a un modelo minimo persistido:

```ts
type PersistedChatBootstrap = {
  sessionId: string | null;
};
```

Estado no persistido:

- `messages`
- `pendingProposal`
- `proposalUiState`
- `status`
- `streamingContent`

Flujo propuesto:

1. Al iniciar la app, si hay `sessionId` persistido, el frontend llama `get_history`.
2. Si responde OK:
   - carga `messages`
   - carga `pendingProposal`
   - deja la sesion activa
3. Si responde `session_not_found`:
   - limpia `sessionId`
   - deja el chat en estado inicial
4. Cuando llega un evento SSE `session`, se persiste el nuevo `sessionId`.

## Contratos y compatibilidad

- El contrato SSE actual debe mantenerse para mensajes en vivo.
- La nueva rehidratacion no debe requerir que el frontend vuelva a reconstruir propuestas desde mensajes locales persistidos.
- La expiracion sigue gobernada por el TTL backend actual de 30 minutos.
- La UI puede seguir mostrando una sola conversacion activa persistible. Un historial durable de multiples conversaciones queda explicitamente fuera de alcance hasta que exista un indice server-side por usuario.

## Riesgos

- Divergencia entre transcript usado por el LLM y transcript serializado a UI si se actualizan por caminos distintos.
- Duplicar mensajes del asistente al persistir tokens parciales y luego una respuesta final consolidada.
- Rehidratar una propuesta cuyo estado ya cambio durante `function_result` si no se unifica la actualizacion de transcript y `pendingProposal`.
- Perder sesiones activas despues de reinicio del servidor por depender de memoria; esto es comportamiento esperado del MVP pero debe quedar claro.
- Cambiar de persistencia local rica a persistencia minima puede romper expectativas actuales del sidebar de historial si esa UI no se ajusta.

## Verificacion

- Tests backend del session store para append, lectura, expiracion y limpieza de `pendingProposal`.
- Tests backend de `chat.ts` para confirmar que el historial de sesion se usa al construir el input del LLM.
- Tests backend del nuevo `get_history` para respuesta exitosa y `session_not_found`.
- Tests frontend del store para confirmar que solo se persiste `sessionId`.
- Tests frontend del hook para rehidratar desde backend, limpiar sesion expirada y continuar con nueva sesion.
- Validacion manual:
  - enviar mensaje
  - refrescar
  - verificar que reaparece transcript y propuesta si existia
  - simular expiracion TTL y verificar que la UI reinicia la sesion
