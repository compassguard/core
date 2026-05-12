# Functional Spec - Chat Transaction Execution With Phantom

Version: 1
Status: Planned
Date: 2026-05-09
Source: user clarification + current front/back contract review

## Alcance

Definir el flujo funcional para ejecutar transacciones propuestas por el chat usando Phantom injected (`window.phantom.solana`) como unico firmante y ejecutor en el cliente.

Incluye:

- proposals de chat para `transfer` y `conditional_buy_sol`
- aprobacion en UI
- preparacion de transaccion por backend cuando haga falta
- firma y envio desde Phantom en frontend
- estados visuales de firma, envio, confirmacion y error
- correccion del drift actual entre contracts front/back

No incluye:

- Phantom Embedded
- backend firmando o enviando transacciones del usuario
- envio de `signed_tx_base64` al backend para transferencias simples
- soporte de wallets distintas a Phantom injected
- implementacion productiva en este handoff

## Decision principal

El frontend no debe devolver la transaccion firmada al backend para que el backend la envie.

Para una transaccion normal:

1. backend emite proposal
2. usuario aprueba en UI
3. backend devuelve unsigned tx preparada
4. frontend pide a Phantom firmar y enviar
5. Phantom devuelve `tx_signature`
6. frontend muestra estado de envio/confirmacion/resultado

El backend puede recibir `tx_signature` solo si se necesita registrar auditoria o continuar una conversacion, pero esa notificacion no es necesaria para ejecutar la transaccion.

## Objetivos

- Mantener autocustodia real: el backend nunca tiene private key ni transaccion firmada.
- Usar Phantom como frontera de firma y envio.
- Evitar el paso innecesario y riesgoso de devolver `signed_tx_base64` al backend.
- Definir un contrato claro para proposals y respuestas de preparacion.
- Alinear schemas, types y UI state del frontend con lo que backend realmente emite.

## Actores y responsabilidades

### Backend

- interpreta intenciones del usuario
- aplica guardrails y risk checks
- emite proposals
- prepara unsigned transactions canonicas cuando corresponde
- devuelve metadata suficiente para que el frontend firme/envie
- puede verificar firmas ya ejecutadas solo para acciones que requieran proof backend

### Frontend

- renderiza proposal
- valida que la wallet conectada coincida con el proposal
- solicita firma/envio a Phantom
- maneja errores locales de Phantom
- muestra estados de ejecucion
- confirma el resultado usando la respuesta de Phantom y, si se implementa, consulta de confirmacion

### Phantom

- firma y envia la transaccion en nombre del usuario
- devuelve la signature o error/cancelacion

## Flujo funcional de transfer

1. Usuario pide transferir SOL.
2. Backend emite proposal `transfer` por SSE.
3. UI entra en `awaiting_approval`.
4. Usuario aprueba en UI.
5. Frontend envia `function_approve` con `session_id`.
6. Backend valida proposal y devuelve `transaction.unsigned_tx_base64`.
7. UI entra en `awaiting_signature`.
8. Frontend deserializa la transaccion y llama a Phantom para firmar y enviar.
9. Phantom devuelve `tx_signature`.
10. UI entra en `submitted` o `confirming`.
11. UI entra en `confirmed` o `failed`.

## Flujo funcional de conditional_buy_sol

`conditional_buy_sol` requiere una decision explicita de implementacion porque hoy el backend espera `execute_tx_signature`.

Decision de esta spec:

- la ejecucion on-chain tambien debe ser firmada/enviada por Phantom en frontend
- el backend no recibe transaccion firmada
- si el backend necesita validar la condicion o registrar que el guard program fue ejecutado, el frontend puede enviar solo `tx_signature`/`execute_tx_signature` como proof post-ejecucion
- esa proof no es necesaria para que Phantom ejecute, pero si puede ser necesaria para que el backend marque la propuesta como completada en el chat

## Estados

Estados canonicos:

- `awaiting_approval`
- `preparing_transaction`
- `awaiting_signature`
- `submitted`
- `confirming`
- `confirmed`
- `failed`
- `cancelled`

Reglas:

- rechazo en UI -> `cancelled`
- rechazo en Phantom -> `cancelled`
- wallet desconectada o distinta -> `failed`
- proposal vencido -> `failed`
- blockhash vencido antes de firmar/enviar -> `failed`
- signature recibida desde Phantom -> `submitted`
- confirmacion exitosa -> `confirmed`

## Correlacion por session

Esta spec no requiere `proposal_id`.

Decision:

- cada `session_id` puede tener como maximo una `pendingProposal` activa
- `function_approve`, `function_reject` y cualquier `function_result` opcional operan sobre esa proposal activa
- si no hay proposal activa, el backend responde `no_pending_proposal`
- si la proposal activa expiro, el backend responde `proposal_expired`
- si el usuario pide otra accion antes de resolver la actual, backend debe rechazarla o reemplazarla de forma explicita; no debe haber dos proposals activas al mismo tiempo

Razon:

- reduce complejidad para el MVP
- coincide con el modelo actual de `pendingProposal` por sesion
- evita introducir identificadores que no aportan si el producto no soporta proposals concurrentes

## Criterios de aceptacion

- La spec documenta que Phantom injected es el unico firmante y ejecutor.
- El backend nunca recibe `signed_tx_base64` para ejecutar transferencias.
- `transfer` usa backend-prepared unsigned tx y frontend `signAndSendTransaction` o equivalente Phantom.
- El resultado primario de ejecucion es `tx_signature` devuelto por Phantom.
- Cualquier callback al backend usa solo `tx_signature`/proof, nunca private key ni signed transaction completa.
- La correlacion usa `session_id` y una unica `pendingProposal` activa; no se requiere `proposal_id`.
- `conditional_buy_sol` queda definido como ejecucion frontend con proof opcional al backend si hace falta completar estado conversacional.
