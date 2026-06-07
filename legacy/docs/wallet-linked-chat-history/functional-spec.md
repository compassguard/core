# Functional Spec: Wallet Linked Chat History

## Alcance

Vincular la rehidratacion del chat y la persistencia local de la sesion activa a la wallet conectada. La feature cubre una sola sesion activa por wallet address y asegura que el historial de una wallet nunca se muestre ni se pueda operar desde otra wallet.

## Objetivos

- Rehidratar el chat activo solo cuando la wallet conectada coincide con la wallet dueña de la sesion.
- Persistir la referencia de sesion en cliente con scope por `walletAddress`, no en una clave global compartida.
- Evitar leakage entre wallets durante refresh, wallet switch o disconnect.
- Hacer obligatorio el uso de `user_address` en `get_history` para sesiones ligadas a wallet.
- Mantener bloqueadas aprobaciones, rechazos y resultados cuando la wallet no coincide con la sesion.

## Fuera de alcance

- Crear un indice completo de multiples sesiones por usuario o una UI de listado server-side de conversaciones.
- Persistencia durable multi-dispositivo o recuperacion despues de reinicio del backend.
- Soporte de historial anonimo sin wallet asociada.
- Cambiar el modelo de generacion de `session_id`, salvo que una tarea dependiente lo requiera mas adelante por separado.

## Casos de uso

1. Como usuario conectado con Wallet A, refresco la pagina y vuelvo a ver el chat activo de Wallet A.
2. Como usuario, cambio de Wallet A a Wallet B y nunca veo mensajes ni propuestas de Wallet A en la sesion de Wallet B.
3. Como usuario, desconecto la wallet y el chat activo deja de mostrarse como sesion rehidratable.
4. Como sistema, si llega un `session_id` persistido pero la wallet actual no coincide, debo tratarlo como inaccesible y responder `session_not_found`.
5. Como sistema, si intento aprobar, rechazar o reportar resultado con una wallet distinta de la dueña de la sesion, la operacion debe quedar bloqueada.

## Reglas funcionales

- La app debe considerar a la wallet conectada como identidad canonica del chat.
- La referencia persistida en cliente debe quedar scopeada por wallet normalizada. No puede existir una referencia global compartida reutilizable entre wallets.
- La rehidratacion del chat no debe ejecutarse hasta que el estado de wallet este resuelto en cliente.
- Si hay wallet conectada:
  - el frontend debe llamar `get_history` con `session_id` y `user_address`
  - el backend debe validar que `user_address` coincide con `session.userAddress`
- Si la wallet cambia:
  - el frontend debe limpiar el estado activo en memoria ligado a la wallet previa
  - el frontend debe cargar solo la referencia persistida de la wallet nueva, si existe
  - el frontend no debe mostrar transitoriamente mensajes ni propuestas de la wallet previa
- Si la wallet se desconecta:
  - el frontend debe limpiar `sessionId`, mensajes y propuesta pendiente del estado activo
  - el frontend no debe hidratar historial mientras no haya una wallet conectada
  - las referencias persistidas por wallet pueden conservarse para futuro reconnect, pero no deben quedar activas en estado desconectado
- Si `get_history` recibe una wallet distinta, o una sesion ligada a wallet sin `user_address` valido, la respuesta debe ser `session_not_found` para no filtrar existencia de sesiones ajenas.
- Las acciones `function_approve`, `function_reject` y `function_result` deben seguir el mismo principio de enforcement por `user_address`.
- La feature cubre una sola sesion activa por wallet. No incluye selector ni listado completo de sesiones por wallet.

## Criterios de aceptacion

- Con Wallet A conectada, si existe una referencia persistida para A y la sesion backend sigue viva, un refresh rehidrata mensajes y propuesta pendiente de A.
- Con Wallet B conectada, la app nunca muestra mensajes, `sessionId` ni propuesta de Wallet A, aunque exista una referencia persistida global previa.
- `get_history` se llama con `user_address` cuando hay wallet conectada.
- El backend responde `session_not_found` cuando `user_address` no coincide con `session.userAddress` o cuando se omite para una sesion wallet-bound.
- Al cambiar de wallet, el estado en memoria se reinicia o cambia al scope de la nueva wallet sin leakage visual intermedio.
- Al desconectar la wallet, la UI deja de exponer una sesion activa rehidratable y bloquea acciones sensibles.
- Aprobar, rechazar o reportar resultado sobre una sesion de otra wallet no es posible ni por UI ni por request backend aceptado.
