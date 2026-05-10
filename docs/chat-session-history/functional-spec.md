# Functional Spec: Chat Session History

## Alcance

Persistir en el frontend la conversacion activa y el `sessionId` asociado para sobrevivir refresh del navegador, y agregar historial de conversaciones manejable desde UI. El alcance es solo UI/localStorage; no incluye base de datos ni sincronizacion backend de historial.

## Objetivos

- Reabrir la conversacion activa despues de un refresh con sus mensajes persistidos.
- Mostrar una lista real de conversaciones guardadas y permitir cambiar entre ellas.
- Permitir borrar una conversacion individual o limpiar todo el historial.
- Evitar rehidratar capacidad de aprobacion insegura cuando la sesion backend ya expiro o la wallet actual no coincide.
- Mantener al backend como fuente de verdad para `pendingProposal`, guardrails y `function_approve`.

## Fuera de alcance

- Persistencia server-side o multi-dispositivo.
- Rehidratar artefactos sensibles de firma o ejecucion.
- Convertir el tab desktop de historial de transacciones en historial de chat.

## Casos de uso

1. Como usuario, si refresco la pagina, quiero volver a ver la conversacion activa sin perder contexto visual.
2. Como usuario, quiero ver mis conversaciones previas y abrir una para leerla nuevamente.
3. Como usuario, quiero borrar una conversacion puntual sin afectar las demas.
4. Como usuario, quiero limpiar todo el historial local cuando lo decida.
5. Como usuario, si una conversacion vieja contiene una propuesta pendiente pero la sesion backend expiro, quiero verla marcada como expirada y no poder aprobarla.
6. Como usuario, si cambio de wallet, quiero poder leer conversaciones anteriores pero no ejecutar aprobaciones sobre conversaciones creadas con otra wallet.

## Reglas funcionales

- El historial se guarda en `localStorage` con `schemaVersion` y estrategia de migracion.
- Cada conversacion persiste como minimo:
  - `conversationId`
  - `sessionId`
  - `messages`
  - `createdAt`
  - `updatedAt`
  - `title`
  - `walletAddressAtCreation`
  - `lastWalletAddress`
- El titulo se deriva del primer mensaje de usuario disponible o de la primera propuesta visible si no hubo texto del usuario.
- No se deben persistir private keys, blobs de transacciones unsigned, transacciones firmadas ni artefactos sensibles de signing.
- El historial persistido es solo representacion UI. Las aprobaciones reales siguen usando `/api/chat` y `function_approve`.
- Si el backend no reconoce el `sessionId` persistido o la sesion ya vencio, la conversacion sigue visible pero su propuesta pendiente debe quedar deshabilitada y marcada como expirada.
- Si la wallet actual no coincide con la wallet asociada a la conversacion, la conversacion queda en modo solo lectura para acciones sensibles; el usuario debe iniciar nueva conversacion para continuar operando.

## Criterios de aceptacion

- Al refrescar, la app rehidrata la conversacion activa, su `sessionId` y su lista de mensajes sin crear una nueva conversacion automaticamente.
- `ChatHistoryList` deja de usar placeholders y muestra conversaciones reales ordenadas por `updatedAt` descendente.
- Seleccionar una conversacion carga sus mensajes en el panel principal y actualiza la conversacion activa.
- Borrar una conversacion la elimina de la lista y, si era la activa, selecciona una alternativa segura o reinicia al estado base.
- "Clear history" elimina todas las conversaciones persistidas y reinicia el chat a estado inicial.
- Una propuesta pendiente rehidratada desde historial nunca queda aprobable si la sesion backend expiro.
- Con wallet distinta, el historial se puede leer pero las acciones de aprobar/enviar quedan bloqueadas o fuerzan nueva conversacion.
