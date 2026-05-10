# Functional Spec: Backend Chat Session History

## Alcance

Mover la fuente de verdad de la conversacion de chat al backend para que:

- el backend administre el transcript completo de la sesion
- el backend administre el `pendingProposal`
- el frontend use `session_id` como identificador de la sesion activa
- un refresh del navegador pueda rehidratar la sesion activa consultando al backend

El alcance cubre una sesion activa rehidratable por `session_id` usando el store backend en memoria ya existente. No cubre persistencia durable fuera de memoria ni historial multi-dispositivo.

## Objetivos

- Evitar que el frontend persista mensajes, conversaciones completas o propuestas en `localStorage`.
- Hacer que el LLM reciba el historial real de la sesion y no solo el ultimo mensaje del usuario.
- Permitir que el frontend recupere la conversacion activa con `session_id` despues de un refresh.
- Mantener al backend como unica fuente operativa de verdad para transcript y `pendingProposal`.
- Preservar el comportamiento de guardrails y aprobaciones existente sobre `/api/chat`.

## Fuera de alcance

- Reemplazar el store en memoria por Redis, Postgres o cualquier base persistente.
- Crear un indice de sesiones por usuario o un historial durable de multiples conversaciones.
- Soportar recuperar una sesion despues de reinicio del servidor o despues del TTL.
- Cambiar el contrato SSE base de `session`, `token`, `proposal`, `done` y `error`, salvo extensiones necesarias para rehidratacion.

## Casos de uso

1. Como usuario, envio un mensaje, refresco la pagina y vuelvo a ver la conversacion activa usando el mismo `session_id`.
2. Como usuario, si el agente preparo una propuesta pendiente, al refrescar la pagina quiero volver a verla desde backend sin depender de `localStorage`.
3. Como usuario, si la sesion expiro o ya no existe en backend, el frontend debe informarlo y empezar una sesion nueva cuando vuelva a escribir.
4. Como sistema, cuando llega un nuevo mensaje del usuario, el backend debe sumar ese mensaje al transcript, usar el historial acumulado para el LLM y persistir la respuesta generada.
5. Como sistema, cuando una propuesta se aprueba, rechaza o informa resultado, el backend debe reflejar ese cambio en el transcript y en el estado de sesion.

## Reglas funcionales

- El backend debe almacenar por sesion:
  - `sessionId`
  - `threadId`
  - `userAddress`
  - transcript ordenado de mensajes
  - `pendingProposal`
  - timestamps de creacion y actualizacion
- El frontend solo puede persistir en `localStorage` el `session_id` activo y metadatos UI no sensibles estrictamente necesarios para bootstrap visual.
- El frontend no debe persistir mensajes del chat, listas de conversaciones, `pendingProposal`, ni snapshots completos de transcript en `localStorage`.
- El backend debe exponer una operacion de lectura de historial por `session_id` para rehidratar la sesion activa despues de refresh.
- Si el `session_id` no existe o expiro, el backend debe responder con error de sesion no encontrada y el frontend debe limpiar la referencia local a esa sesion.
- El transcript backend debe incluir, como minimo, mensajes de usuario, respuestas del asistente, propuestas generadas y resultado final de aprobar/rechazar/ejecutar cuando aplique.
- Las aprobaciones y rechazos deben seguir pasando por backend; el frontend no puede reconstruir estado aprobable por si solo.

## Criterios de aceptacion

- Despues de enviar al menos un mensaje, un refresh recupera la conversacion activa desde backend usando el `session_id` persistido.
- `BACK/services/chat.ts` deja de invocar al LLM con solo el ultimo mensaje del usuario y usa el historial almacenado en la sesion.
- Al recibir una propuesta por SSE, refrescar la pagina muestra otra vez esa propuesta consultando backend, siempre que la sesion siga viva.
- El frontend deja de persistir mensajes y conversaciones completas en `localStorage`.
- Si la sesion ya no existe en backend, el frontend deja de mostrarla como activa y la siguiente interaccion crea una sesion nueva.
- Aprobar, rechazar o reportar `function_result` deja evidencia consistente en el estado de sesion backend y mantiene coherencia despues de rehidratacion.
