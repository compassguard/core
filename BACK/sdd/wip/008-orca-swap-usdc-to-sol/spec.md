# 008 - Orca Swap Execution (USDC -> SOL, Devnet)

## Problem statement

Actualmente el agente no puede ejecutar swaps reales en Orca. Solo existen flujos de transferencia y flujos de compra condicional/simulación. Se requiere que el agente ejecute **swap real USDC -> SOL en devnet**, con firma de usuario en frontend (wallet no embebida) y sin guardrail on-chain adicional en esta iteración.

## Scope in/out

### In scope

1. Soportar intención en lenguaje natural para swap **USDC -> SOL**.
2. Integrar Orca (Whirlpools SDK) en backend para cotizar y preparar transacción de swap.
3. Mantener flujo HITL actual:
   - `user_message` por SSE (proposal),
   - `function_approve` / `function_reject` por JSON.
4. En `function_approve`, retornar transacción unsigned serializada (base64) para firma del frontend.
5. Red objetivo: **Solana devnet**.
6. Mints estándar devnet:
   - devUSDC: `BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k`
   - WSOL: `So11111111111111111111111111111111111111112`

### Out of scope

1. Guardrail on-chain con AgentActionGuard para esta feature.
2. Rutas multi-hop o multi-token (solo USDC -> SOL).
3. Mainnet.
4. Automatización sin aprobación del usuario.

## Functional requirements

### FR-1 Intent parsing

Detectar mensajes tipo:
- "comprame 10 usdc de sol"
- "swap 10 usdc a sol"
- "convierte 5 usdc a sol"

Y mapear a:

```ts
{
  input_token: 'USDC',
  output_token: 'SOL',
  input_amount: number,
  slippage_bps?: number
}
```

### FR-2 Tool de agente

Agregar tool `swap_orca_usdc_to_sol` en backend.

Debe:
1. validar monto > 0,
2. cotizar en Orca devnet,
3. calcular output estimado,
4. devolver proposal con summary/risk/display.

### FR-3 Proposal por SSE

Para `user_message` con swap válido:
- enviar `event: proposal` con `type: function_call`.
- `function.name = "swap_orca_usdc_to_sol"`.
- incluir params exactos y quote estimado.

### FR-4 Approve JSON prepara tx real

En `function_approve` cuando proposal pendiente sea `swap_orca_usdc_to_sol`:
1. construir transacción real de Orca swap en devnet,
2. retornar unsigned tx base64 al frontend,
3. no firmar en backend.

Respuesta incluye:

```json
{
  "messages": [...],
  "transaction": {
    "format": "base64_versioned_transaction",
    "unsigned_tx_base64": "...",
    "recent_blockhash": "...",
    "last_valid_block_height": 123,
    "network": "devnet",
    "execution_type": "orca_swap_usdc_to_sol"
  }
}
```

### FR-5 Reject flow

`function_reject` limpia proposal pendiente y responde cancelación.

### FR-6 Determinismo de sesión

`session_id` debe mantener proposal y parámetros exactos hasta approve/reject.

## Non-functional requirements (latency, security, auditability, idempotency)

### Latency
- Proposal SSE < 2s p95 para requests válidos.
- Approve build tx < 5s p95 en devnet (sin firma).

### Security
- Backend nunca recibe private key ni firma por usuario.
- Payer/signer de tx = wallet conectada del usuario.

### Auditability
- Loggear `session_id`, monto input, output estimado, pool usado, slippage, blockhash.

### Idempotency
- Repetir approve sobre misma proposal puede regenerar tx (nuevo blockhash), sin mover fondos hasta firma frontend.

## Data impact (new columns, migrations, indexes, backfill)

Sin DB/migraciones.

Cambios in-memory:
- `pendingProposal.toolName` soporta `swap_orca_usdc_to_sol`.
- `pendingProposal.toolArgs` agrega quote/pool/slippage.

## API contract changes (request/response/status codes/errors)

### Request

No cambia contrato base:
- `user_message`
- `function_approve`
- `function_reject`

### Response changes

`function_call.name` ahora puede incluir:
- `swap_orca_usdc_to_sol`

`function_approve` para swap devuelve `transaction` unsigned.

### New errors
- `orca_quote_failed`
- `orca_pool_not_found`
- `orca_tx_build_failed`
- `unsupported_swap_pair`
- `invalid_swap_amount`

## Authorization and permission expectations

1. Frontend wallet del usuario firma y envía la tx.
2. Backend solo prepara tx.
3. Solo USDC->SOL permitido en esta iteración.

## Observability requirements (logs/metrics/events)

Logs:
- `[swap-orca] proposal_created {session_id, amount_usdc, est_sol_out}`
- `[swap-orca] tx_prepared {session_id, blockhash}`
- `[swap-orca] quote_failed {session_id, reason}`

Métricas (si aplica):
- `orca_swap_proposals_total`
- `orca_swap_tx_prepared_total`
- `orca_swap_errors_total{reason=...}`

## Acceptance criteria (testable)

1. Dado mensaje "swap 10 usdc a sol", backend emite proposal `swap_orca_usdc_to_sol`.
2. Approve devuelve tx unsigned base64 válida para devnet.
3. Reject cancela y limpia estado pendiente.
4. Mensajes con par distinto (ej. SOL->USDC) retornan `unsupported_swap_pair`.
5. Build/test del proyecto principal pasan.

## Design before code: slices, risks, rollback

### Slice 1 - Backend Orca service

Archivos:
- `BACK/services/orcaSwap.ts` (nuevo)

Contenido:
- quote USDC->SOL
- build unsigned swap tx

### Slice 2 - Integración chat tool

Archivos:
- `BACK/services/chat.ts`

Contenido:
- agregar tool definition
- handler proposal
- approve path para devolver tx unsigned

### Slice 3 - Types/schemas frontend contract compatibility

Archivos:
- `FRONT/src/types/api.ts`
- `FRONT/src/lib/api/schemas.ts` (si aplica)

Contenido:
- soportar nuevo function name en tipos

### Slice 4 - Tests/regression

- tests unitarios de parseo/validación
- regression chat existing transfer

### Risks

1. Cambios en SDK Orca / APIs devnet.
2. Liquidez/pool devnet no disponible temporalmente.
3. Desalineación decimales USDC/SOL al convertir montos.

### Rollback strategy

Feature flag `ORCA_SWAP_ENABLED=false`:
- si falla Orca, deshabilitar tool sin afectar transfer/chat.

## Test plan mapping

1. Unit: parse de input amount y par permitido.
2. Integration: quote Orca devnet success/failure.
3. Integration: approve retorna `unsigned_tx_base64` no vacío.
4. Regression: transfer tool actual sigue funcionando.

## Discovery summary

### Business goal
Ejecutar swaps reales USDC->SOL usando Orca, manteniendo firma del usuario en frontend.

### Current behavior
No hay ejecución de swap real Orca.

### Constraints
- Devnet only
- Wallet no embebida
- Sin smart-contract guardrail en esta fase

### Affected modules
- BACK chat service
- BACK nueva integración Orca
- FRONT tipos contrato

---

**Status:** Implemented (backend MVP)  
**Owner:** BACK + FRONT  
**Created:** 2026-05-10

## Implementation notes

- Se agregó tool backend `swap_orca_usdc_to_sol` al agente.
- Se implementó `BACK/services/tools/orcaSwap.ts` con quote USDC->SOL en devnet usando Orca public API (tokens endpoint) y mints/pool estándar devnet.
- Se amplió soporte práctico a ambos sentidos en devnet: `USDC->SOL` y `SOL->USDC` para fondeo de devUSDC desde SOL.
- `user_message` ahora puede producir proposal `function_call` de swap Orca.
- `function_approve` para swap retorna `transaction.unsigned_tx_base64` (legacy tx) + `swap_execution` para firma y envío desde frontend (Phantom).
- Se mantiene compatibilidad con tools previas (`transfer`, `conditional_buy_sol`).

### Limitation in this MVP backend

- No se retorna aún `unsigned_tx_base64` de Orca swap desde backend debido a incompatibilidad runtime/wasm del SDK en esta integración Next server actual.
- La ejecución final del swap queda delegada al frontend con Orca SDK usando los parámetros aprobados.
