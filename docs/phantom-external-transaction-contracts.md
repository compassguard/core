# Contratos de transacciones para Phantom externa

**Estado:** draft de arquitectura / contratos  
**Fecha:** 2026-05-09  
**Alcance:** solo transacciones. No cubre balances, portfolio, historial ni UI de login salvo lo necesario para firmar.  
**Motivo:** documento extra al fix de login para explicar qué contratos deben cambiar al dejar Phantom Embedded Wallet.

---

## 1. Problema

Hubo un problema al querer hacer el login con **Phantom Embedded Wallet**. Para simplificar el onboarding se migró el login hacia **Phantom externa/injected provider** (`window.phantom.solana`), sin App ID, sin redirect URLs y sin wallet embebida.

Ese cambio resuelve el login, pero cambia una premisa importante del sistema:

```txt
Con Phantom Embedded / modelo anterior:
  se asumía que el backend/agent podía terminar ejecutando transacciones por el usuario.

Con Phantom externa:
  el backend/agent NO tiene la private key del usuario.
  la firma debe ocurrir en el navegador mediante Phantom.
```

Por tanto, el contrato actual de transacciones queda incompleto. El frontend ya no puede limitarse a mandar `function_approve` y esperar que el backend ejecute como si pudiera firmar por el usuario.

---

## 2. Cambio de arquitectura

### Antes: agent ejecuta server-side

```txt
Usuario escribe intent
  → Frontend POST /api/agent/message
  → Backend/agent responde function_call si requiere aprobación
  → Usuario confirma
  → Frontend POST { type: "function_approve" }
  → Backend/agent firma/envía/ejecuta
  → Backend responde text+execute
```

### Ahora: backend prepara, Phantom firma, backend o frontend envía

Para mantener self-custody con Phantom externa:

```txt
Usuario escribe intent
  → Backend/agent interpreta, cotiza, valida riesgo y construye tx SIN firmar
  → Frontend recibe tx serializada preparada
  → Frontend pide firma a Phantom
  → Usuario aprueba en Phantom
  → Tx firmada vuelve al backend para submit/confirmación
  → Backend responde resultado text+execute
```

Regla central nueva:

```txt
Backend/agent construye, valida, risk-scorea y audita.
Frontend NO construye la transacción.
Frontend SÍ solicita la firma a Phantom sobre una tx construida por backend.
Phantom/usuario es el firmante.
```

---

## 3. Contrato actual documentado

La documentación de frontend actual define un protocolo de function-calling en:

```txt
FRONT/docs/frontend-spec.md
FRONT/docs/task-specs/T4-agent-swap-flow.md
FRONT/docs/task-specs/T6-api-contracts-zod.md
```

### 3.1 Backend → frontend actual

El backend devuelve mensajes:

```ts
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
        name: 'swap' | 'transfer' | 'stake';
        params: SwapParams | TransferParams | StakeParams;
      };
      display: {
        summary: string;
        fee_usd?: number;
        provider?: string;
        slippage_bps?: number;
      };
      risk: RiskInfo;
      timestamp: string;
    }
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: string;
    };
```

### 3.2 Frontend → backend actual

El frontend manda:

```ts
type AgentMessageRequest =
  | { type: 'user_message'; content: string; user_threshold_usd?: number }
  | { type: 'function_approve' }
  | { type: 'function_reject' };
```

### 3.3 Problema del contrato actual

`function_approve` actualmente significa:

```txt
"usuario aprobó, backend ejecutá"
```

Pero con Phantom externa debería significar como mínimo:

```txt
"usuario aprobó en la UI, prepará una tx para que Phantom la firme"
```

El contrato actual no incluye:

- `proposal_id` para correlacionar propuesta ↔ tx preparada ↔ tx firmada.
- `unsigned_transaction` serializada.
- `prepared_transaction_id` / TTL.
- `message_hash` o hash de la transacción preparada.
- `signed_transaction` de vuelta al backend.
- estados `preparing`, `awaiting_signature`, `submitting`, `confirming`.
- errores específicos de Phantom: usuario rechazó, wallet desconectada, cuenta cambió.

---

## 4. Contrato objetivo para transacciones

Para transacciones con Phantom externa se propone dividir el flujo en cuatro contratos:

```txt
A. Chat/propuesta
B. Prepare unsigned transaction
C. Phantom signature en frontend
D. Submit signed transaction + resultado
```

---

## 5. A. Contrato de propuesta del agent

Endpoint existente:

```txt
POST /api/agent/message
```

### 5.1 Request: user_message

Debe empezar a incluir la wallet conectada, o derivarla de sesión autenticada.

```ts
type AgentUserMessageRequest = {
  type: 'user_message';
  content: string;
  wallet_address: string;
  user_threshold_usd?: number;
};
```

> Si existe sesión server-side, `wallet_address` puede validarse contra la sesión. Si no existe todavía, se puede aceptar para demo, pero no debe considerarse seguro.

### 5.2 Response: function_call con metadata de ejecución

El `function_call` debe agregar identificadores y modo de ejecución:

```ts
type AgentFunctionCallMessage = {
  type: 'function_call';
  proposal_id: string;
  function: {
    name: 'swap' | 'transfer' | 'stake';
    params: SwapParams | TransferParams | StakeParams;
  };
  display: {
    summary: string;
    fee_usd?: number;
    provider?: string;
    slippage_bps?: number;
    quote_id?: string;
  };
  risk: RiskInfo;
  execution: {
    mode: 'user_signature';
    prepare_endpoint: '/api/transactions/prepare';
    expires_at?: string;
  };
  timestamp: string;
};
```

Ejemplo JSON:

```json
{
  "messages": [
    {
      "type": "function_call",
      "proposal_id": "prop_01HZY...",
      "function": {
        "name": "swap",
        "params": {
          "amount_in": 5,
          "token_in": "SOL",
          "token_out": "USDC",
          "slippage_bps": 50
        }
      },
      "display": {
        "summary": "Swap 5 SOL → ~725 USDC",
        "fee_usd": 0.04,
        "provider": "Jupiter",
        "slippage_bps": 50,
        "quote_id": "quote_abc123"
      },
      "risk": {
        "score": 65,
        "level": "medium",
        "reasons": ["Amount is above threshold", "Slippage tolerance is 0.5%"]
      },
      "execution": {
        "mode": "user_signature",
        "prepare_endpoint": "/api/transactions/prepare",
        "expires_at": "2026-05-09T23:59:00Z"
      },
      "timestamp": "2026-05-09T23:54:00Z"
    }
  ]
}
```

### Cambio necesario

Actualmente el frontend asume una sola propuesta pendiente y no usa ID. Para transacciones reales debe guardarse `proposal_id` aunque sigamos permitiendo una sola propuesta activa. Esto evita replay, confusiones de sesión y submit de una tx que no corresponde.

---

## 6. B. Contrato prepare unsigned transaction

Nuevo endpoint recomendado:

```txt
POST /api/transactions/prepare
```

Responsabilidad del backend/agent:

- Revalidar la propuesta.
- Revalidar quote/risk/threshold.
- Construir la transacción Solana completa.
- Setear `feePayer = wallet_address`.
- Setear blockhash/recent blockhash válido.
- Simular si aplica.
- Serializar sin requerir firma del usuario.
- Guardar hash/TTL para verificar submit.
- Devolver transacción lista para que Phantom la firme.

### 6.1 Request

```ts
type PrepareTransactionRequest = {
  proposal_id: string;
  wallet_address: string;
  cluster: 'devnet' | 'mainnet-beta';
  client_context?: {
    expected_wallet_address?: string;
    ui_confirmed_at?: string;
  };
};
```

Ejemplo:

```json
{
  "proposal_id": "prop_01HZY...",
  "wallet_address": "7Xg2...k3Qa",
  "cluster": "devnet",
  "client_context": {
    "expected_wallet_address": "7Xg2...k3Qa",
    "ui_confirmed_at": "2026-05-09T23:55:00Z"
  }
}
```

### 6.2 Response

```ts
type PrepareTransactionResponse = {
  prepared_transaction_id: string;
  proposal_id: string;
  wallet_address: string;
  cluster: 'devnet' | 'mainnet-beta';
  transaction: {
    encoding: 'base64';
    kind: 'legacy' | 'versioned';
    value: string;
    message_hash: string;
  };
  required_signers: string[];
  expires_at: string;
  display: {
    summary: string;
    fee_lamports?: number;
    fee_usd?: number;
    provider?: string;
    slippage_bps?: number;
  };
  risk: RiskInfo;
  simulation?: {
    ok: boolean;
    logs?: string[];
    error?: string;
  };
};
```

Ejemplo:

```json
{
  "prepared_transaction_id": "ptx_01HZZ...",
  "proposal_id": "prop_01HZY...",
  "wallet_address": "7Xg2...k3Qa",
  "cluster": "devnet",
  "transaction": {
    "encoding": "base64",
    "kind": "versioned",
    "value": "AQAAAAAAAAAAAA...",
    "message_hash": "sha256:abc123..."
  },
  "required_signers": ["7Xg2...k3Qa"],
  "expires_at": "2026-05-10T00:00:00Z",
  "display": {
    "summary": "Swap 5 SOL → ~725 USDC",
    "fee_lamports": 5000,
    "fee_usd": 0.04,
    "provider": "Jupiter",
    "slippage_bps": 50
  },
  "risk": {
    "score": 65,
    "level": "medium",
    "reasons": ["Amount is above threshold"]
  },
  "simulation": {
    "ok": true,
    "logs": []
  }
}
```

### 6.3 Errores

Debe usar el shape actual del frontend:

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
```

Códigos sugeridos:

| HTTP | `error.code` | Cuándo |
|---:|---|---|
| 400 | `invalid_payload` | body inválido |
| 401 | `unauthenticated` | falta sesión / SIWS |
| 403 | `wallet_mismatch` | wallet del body no coincide con sesión |
| 404 | `proposal_not_found` | no existe `proposal_id` |
| 409 | `proposal_expired` | quote/propuesta vencida |
| 409 | `proposal_already_prepared` | ya hay una tx preparada activa |
| 422 | `simulation_failed` | simulación falló |
| 422 | `risk_blocked` | risk policy bloquea |
| 500 | `transaction_prepare_failed` | error interno |

---

## 7. C. Firma con Phantom en frontend

No es un endpoint HTTP. Es una operación local del navegador.

Responsabilidad del frontend:

- Verificar que la wallet conectada sigue siendo `wallet_address`.
- Deserializar la tx recibida.
- Pedir firma a Phantom.
- Serializar la tx firmada.
- Enviar la tx firmada al backend.

El frontend **no debe** alterar instrucciones, accounts, amounts, slippage ni fee payer.

### 7.1 Tipos de Phantom necesarios

`FRONT/src/types/phantom.ts` ya tiene:

```ts
signTransaction<TTransaction>(transaction: TTransaction): Promise<TTransaction>;
signAllTransactions<TTransaction>(transactions: TTransaction[]): Promise<TTransaction[]>;
```

Si se decide que Phantom envíe directamente, habría que agregar también:

```ts
signAndSendTransaction<TTransaction>(transaction: TTransaction): Promise<{ signature: string }>;
```

Para este contrato recomendamos inicialmente:

```txt
Phantom firma → backend submit
```

porque permite auditoría, retries, status y tracking del agent.

### 7.2 Resultado local de firma

```ts
type PhantomSignResult = {
  prepared_transaction_id: string;
  proposal_id: string;
  signed_transaction: {
    encoding: 'base64';
    kind: 'legacy' | 'versioned';
    value: string;
  };
  signed_at: string;
};
```

Errores UI esperados:

| Caso | Estado frontend |
|---|---|
| Usuario cierra/rechaza popup | `signature_rejected` |
| Wallet desconectada | `wallet_disconnected` |
| Usuario cambió de cuenta | `wallet_mismatch` |
| Tx expirada antes de firmar | `prepared_transaction_expired` |
| Phantom error genérico | `signature_failed` |

---

## 8. D. Contrato submit signed transaction

Nuevo endpoint recomendado:

```txt
POST /api/transactions/submit
```

Responsabilidad del backend:

- Autenticar usuario/sesión.
- Buscar `prepared_transaction_id`.
- Verificar TTL.
- Verificar que la tx firmada corresponde a la tx preparada (`message_hash`).
- Verificar signer esperado.
- Opcionalmente re-simular.
- Enviar con `sendRawTransaction`.
- Confirmar o devolver estado `submitted`.
- Responder con shape compatible con el chat.

### 8.1 Request

```ts
type SubmitSignedTransactionRequest = {
  proposal_id: string;
  prepared_transaction_id: string;
  wallet_address: string;
  cluster: 'devnet' | 'mainnet-beta';
  signed_transaction: {
    encoding: 'base64';
    kind: 'legacy' | 'versioned';
    value: string;
  };
};
```

Ejemplo:

```json
{
  "proposal_id": "prop_01HZY...",
  "prepared_transaction_id": "ptx_01HZZ...",
  "wallet_address": "7Xg2...k3Qa",
  "cluster": "devnet",
  "signed_transaction": {
    "encoding": "base64",
    "kind": "versioned",
    "value": "AbCdSignedTx..."
  }
}
```

### 8.2 Response recomendada

Para integrarse con el chat actual, la respuesta puede reutilizar `AgentMessageResponse`:

```ts
type SubmitSignedTransactionResponse = {
  messages: AgentMessage[];
  transaction: {
    proposal_id: string;
    prepared_transaction_id: string;
    signature: string;
    cluster: 'devnet' | 'mainnet-beta';
    status: 'submitted' | 'confirmed' | 'finalized' | 'failed';
    explorer_url?: string;
  };
};
```

Ejemplo:

```json
{
  "messages": [
    {
      "type": "text",
      "content": "Done. Transaction submitted successfully.",
      "execute": {
        "status": "success",
        "tx_hash": "5xYdemo111111111111111111111111111111111111111111111111111"
      },
      "timestamp": "2026-05-10T00:01:00Z"
    }
  ],
  "transaction": {
    "proposal_id": "prop_01HZY...",
    "prepared_transaction_id": "ptx_01HZZ...",
    "signature": "5xYdemo111111111111111111111111111111111111111111111111111",
    "cluster": "devnet",
    "status": "submitted",
    "explorer_url": "https://explorer.solana.com/tx/5xY...?cluster=devnet"
  }
}
```

### 8.3 Errores

| HTTP | `error.code` | Cuándo |
|---:|---|---|
| 400 | `invalid_payload` | body inválido |
| 401 | `unauthenticated` | sesión inválida |
| 403 | `wallet_mismatch` | wallet no coincide |
| 404 | `prepared_transaction_not_found` | no existe `prepared_transaction_id` |
| 409 | `prepared_transaction_expired` | tx vencida |
| 409 | `transaction_already_submitted` | submit duplicado |
| 422 | `transaction_mismatch` | tx firmada no coincide con preparada |
| 422 | `invalid_signature` | signer no es wallet esperada |
| 422 | `simulation_failed` | re-simulación falla |
| 502 | `rpc_send_failed` | RPC no aceptó tx |
| 500 | `transaction_submit_failed` | error interno |

---

## 9. E. Contrato status/confirmación

Opcional para fase inicial, recomendado para UX real.

```txt
GET /api/transactions/status?signature=<signature>&cluster=devnet
```

Response:

```ts
type TransactionStatusResponse = {
  signature: string;
  cluster: 'devnet' | 'mainnet-beta';
  status: 'submitted' | 'confirmed' | 'finalized' | 'failed';
  confirmations?: number;
  slot?: number;
  error?: string;
  updated_at: string;
};
```

El frontend puede poller este endpoint hasta `confirmed/finalized/failed` y luego refetchear balances/allocation/history.

---

## 10. Cambios en tipos frontend

### 10.1 `FRONT/src/types/api.ts`

Agregar o modificar:

```ts
export type ExecutionMode = 'agent_server' | 'user_signature';

export type TransactionEncoding = 'base64';
export type SolanaTransactionKind = 'legacy' | 'versioned';
export type SolanaCluster = 'devnet' | 'mainnet-beta';

export type PreparedTransactionPayload = {
  encoding: TransactionEncoding;
  kind: SolanaTransactionKind;
  value: string;
  message_hash: string;
};

export type AgentFunctionCall = {
  type: 'function_call';
  proposal_id: string;
  function: {
    name: 'swap' | 'transfer' | 'stake';
    params: SwapParams | TransferParams | StakeParams;
  };
  display: {
    summary: string;
    fee_usd?: number;
    provider?: string;
    slippage_bps?: number;
    quote_id?: string;
  };
  risk: RiskInfo;
  execution: {
    mode: 'user_signature';
    prepare_endpoint: '/api/transactions/prepare';
    expires_at?: string;
  };
  timestamp: string;
};

export type PrepareTransactionRequest = {
  proposal_id: string;
  wallet_address: string;
  cluster: SolanaCluster;
  client_context?: {
    expected_wallet_address?: string;
    ui_confirmed_at?: string;
  };
};

export type PrepareTransactionResponse = {
  prepared_transaction_id: string;
  proposal_id: string;
  wallet_address: string;
  cluster: SolanaCluster;
  transaction: PreparedTransactionPayload;
  required_signers: string[];
  expires_at: string;
  display: {
    summary: string;
    fee_lamports?: number;
    fee_usd?: number;
    provider?: string;
    slippage_bps?: number;
  };
  risk: RiskInfo;
  simulation?: {
    ok: boolean;
    logs?: string[];
    error?: string;
  };
};

export type SubmitSignedTransactionRequest = {
  proposal_id: string;
  prepared_transaction_id: string;
  wallet_address: string;
  cluster: SolanaCluster;
  signed_transaction: {
    encoding: 'base64';
    kind: SolanaTransactionKind;
    value: string;
  };
};

export type SubmitSignedTransactionResponse = {
  messages: AgentMessage[];
  transaction: {
    proposal_id: string;
    prepared_transaction_id: string;
    signature: string;
    cluster: SolanaCluster;
    status: 'submitted' | 'confirmed' | 'finalized' | 'failed';
    explorer_url?: string;
  };
};
```

### 10.2 `FRONT/src/lib/api/schemas.ts`

Agregar schemas Zod equivalentes para:

```txt
PrepareTransactionResponseSchema
SubmitSignedTransactionResponseSchema
TransactionStatusResponseSchema
```

y actualizar `AgentMessageSchema` para aceptar:

```txt
proposal_id
execution.mode
execution.prepare_endpoint
execution.expires_at
```

### 10.3 `FRONT/src/lib/api/client.ts`

Agregar métodos:

```ts
prepareTransaction(body: PrepareTransactionRequest): Promise<PrepareTransactionResponse>
submitSignedTransaction(body: SubmitSignedTransactionRequest): Promise<SubmitSignedTransactionResponse>
getTransactionStatus(signature: string, cluster: SolanaCluster): Promise<TransactionStatusResponse>
```

---

## 11. Cambios en estado/UI frontend

El store actual maneja:

```txt
idle → thinking → awaiting_approval → executing → idle
```

Con firma Phantom externa se necesita más granularidad:

```ts
type ProposalUiState =
  | 'pending'
  | 'preparing_transaction'
  | 'awaiting_signature'
  | 'signature_rejected'
  | 'submitting_transaction'
  | 'confirming_transaction'
  | 'confirmed'
  | 'failed'
  | 'cancelled';
```

Flujo recomendado:

```txt
function_call recibido
  → pending
usuario confirma en UI
  → preparing_transaction
prepare ok
  → awaiting_signature
Phantom firma ok
  → submitting_transaction
submit ok
  → confirming_transaction o confirmed
confirm ok
  → confirmed
```

Errores clave:

```txt
Phantom reject → signature_rejected
wallet mismatch → failed con copy: "La cuenta activa en Phantom cambió"
prepare expired → failed/retry
submit failed → failed con detalle de RPC/simulación
```

---

## 12. Cambios backend

### 12.1 `app/api/agent/message/route.ts`

Cambiar semántica:

- `user_message` puede devolver `function_call` con `proposal_id` y `execution.mode = 'user_signature'`.
- `function_approve` ya no debería ejecutar directamente transacciones reales.
- Para compatibilidad demo puede seguir existiendo, pero en producción debe moverse a prepare/sign/submit.

Recomendación:

```txt
/api/agent/message       → chat/propuestas/rechazo
/api/transactions/prepare → construir unsigned tx
/api/transactions/submit  → recibir signed tx y enviar
/api/transactions/status  → confirmar
```

### 12.2 Nuevos services backend

Crear una capa tipo:

```txt
BACK/services/transactions/prepareTransaction.ts
BACK/services/transactions/submitSignedTransaction.ts
BACK/services/transactions/verifyPreparedTransaction.ts
BACK/services/transactions/status.ts
```

Responsabilidades mínimas:

```txt
prepare:
  - cargar proposal/quote
  - validar wallet
  - construir tx
  - simular
  - guardar prepared_transaction_id + hash + TTL

submit:
  - cargar prepared tx
  - verificar TTL
  - verificar tx hash/mensaje
  - verificar signer wallet
  - re-simular si aplica
  - sendRawTransaction
  - persistir signature/status
```

---

## 13. Seguridad/autenticación mínima

Con Phantom externa, conectar wallet en frontend no autentica por sí solo al backend.

Para endpoints de transacciones se necesita una de estas opciones:

### Opción recomendada: Sign-In with Solana mínimo

```txt
1. Backend emite nonce/challenge.
2. Frontend pide a Phantom signMessage(challenge).
3. Backend verifica firma contra wallet_address.
4. Backend emite sesión/JWT corto.
5. prepare/submit validan sesión y wallet.
```

Contratos sugeridos, aunque pueden documentarse en otro archivo:

```txt
GET  /api/auth/challenge?wallet_address=...
POST /api/auth/verify
```

### Checks obligatorios en transacciones

- `wallet_address` de request coincide con sesión.
- `wallet_address` coincide con signer requerido de la tx.
- `prepared_transaction_id` pertenece a la sesión/wallet.
- `message_hash` de tx firmada coincide con la preparada.
- TTL corto para prepared tx: 2-5 minutos.
- No aceptar submit duplicado salvo idempotencia controlada.
- Simular antes de submit si el coste/latencia lo permite.

---

## 14. Impacto en archivos actuales

### Frontend

| Archivo | Cambio |
|---|---|
| `FRONT/src/types/api.ts` | Agregar `proposal_id`, `execution`, contratos prepare/submit/status. |
| `FRONT/src/lib/api/schemas.ts` | Validación Zod para nuevos contratos. |
| `FRONT/src/lib/api/client.ts` | Métodos `prepareTransaction`, `submitSignedTransaction`, `getTransactionStatus`. |
| `FRONT/src/hooks/useAgentMessage.ts` | `approveProposal()` ya no solo manda `function_approve`; debe orquestar prepare → sign → submit. |
| `FRONT/src/stores/chatStore.ts` | Guardar `proposal_id`, `prepared_transaction_id`, estados de firma. |
| `FRONT/src/components/chat/proposals/*` | Mostrar estados `preparing`, `awaiting_signature`, `submitting`, `confirmed`, `failed`. |
| `FRONT/src/types/phantom.ts` | Confirmar soporte de `signTransaction`; opcional `signAndSendTransaction`. |

### Backend

| Archivo/ruta | Cambio |
|---|---|
| `app/api/agent/message/route.ts` | Dejar de simular ejecución directa en `function_approve` para tx reales. |
| `app/api/transactions/prepare/route.ts` | Nuevo endpoint. |
| `app/api/transactions/submit/route.ts` | Nuevo endpoint. |
| `app/api/transactions/status/route.ts` | Nuevo endpoint opcional. |
| `BACK/services/*` | Nuevo servicio de construcción/verificación/submit de tx. |
| Persistencia/cache | Guardar proposal/prepared tx/hash/TTL/status. |

### Docs a actualizar luego

Los docs actuales de `FRONT/docs` todavía dicen que el frontend nunca firma. Para Phantom externa deberían cambiar a:

```txt
El frontend no construye, simula ni decide transacciones.
El frontend sí solicita firma a Phantom para transacciones preparadas por backend.
```

---

## 15. Fases recomendadas

### Fase 1: Contratos y mocks

- Actualizar tipos/Zod.
- Backend mock de `/api/transactions/prepare` que devuelva una tx devnet/simple o fixture.
- Backend mock de `/submit` que valide shape y devuelva `text+execute` demo.
- UI de estados prepare/sign/submit sin transacción real si hace falta.

### Fase 2: Firma real con Phantom en devnet

- Deserializar tx preparada.
- `provider.signTransaction(tx)`.
- Serializar tx firmada.
- Submit a backend.
- Confirmar en devnet.

### Fase 3: Swap real / provider real

- Backend construye tx con Jupiter/swap provider.
- Validación de quote/slippage/risk.
- Simulation antes de firma/submit.

### Fase 4: Seguridad

- SIWS/session.
- TTL/hash verification.
- Idempotencia en submit.
- Rate limiting y audit log.

---

## 16. No-alcance por ahora

No cubierto en este documento:

- Balances reales.
- Allocation/portfolio.
- Historial real.
- Multi-wallet.
- Mobile deep links.
- Delegación/autonomous agent con session keys.
- Vault/program para permisos limitados.
- Phantom Embedded/server SDK.
- Mainnet por defecto.

---

## 17. Decisión abierta

Hay dos formas finales de enviar la transacción:

### Opción A: frontend firma y backend submit

```txt
prepare backend → sign Phantom → submit backend
```

Pros:

- Mejor auditoría.
- Backend puede confirmar/reintentar.
- Agent mantiene tracking.

Contras:

- Más endpoints.
- Backend debe validar tx firmada.

### Opción B: frontend usa `signAndSendTransaction`

```txt
prepare backend → Phantom signAndSend → frontend reporta signature
```

Pros:

- Menos backend.
- Más simple para MVP.

Contras:

- Menos control de submit/retry.
- Backend recibe resultado después, no controla envío.

**Recomendación inicial:** Opción A para mantener trazabilidad del agent.

---

## 18. Conclusión

El fix de login sin wallet embebida simplifica onboarding, pero obliga a cambiar los contratos de transacciones.

El contrato viejo:

```txt
function_call → function_approve → backend ejecuta
```

no alcanza con Phantom externa.

El contrato nuevo debe ser:

```txt
function_call con proposal_id
  → prepare unsigned transaction
  → Phantom signTransaction
  → submit signed transaction
  → text+execute / status
```

Así mantenemos:

- self-custody real;
- backend/agent como cerebro de construcción y seguridad;
- frontend sin lógica de construcción de tx;
- Phantom como firmante explícito del usuario.
