# Technical Spec - Frontend-Executed Phantom Transactions

Version: 1
Status: Planned
Date: 2026-05-09
Source: user clarification + current front/back contract review

## Arquitectura

`/api/chat` sigue siendo el contrato para chat, proposals y preparacion. La ejecucion on-chain de transacciones de usuario ocurre en frontend mediante Phantom injected.

Flujo tecnico para `transfer`:

1. `POST /api/chat` con `type: "user_message"` streama un proposal.
2. Frontend renderiza el proposal.
3. `POST /api/chat` con `type: "function_approve"` valida el proposal y devuelve unsigned tx.
4. Frontend deserializa `unsigned_tx_base64`.
5. Frontend llama a Phantom `signAndSendTransaction` si esta disponible.
6. Phantom devuelve `tx_signature`.
7. Frontend actualiza estado local y confirma si la implementacion incorpora RPC de confirmacion.

El backend no recibe `signed_tx_base64` para transferencias.

## Contrato de proposal

```ts
type ProposalEnvelope = {
  type: 'function_call';
  function: TransferProposal | ConditionalBuySolProposal;
  display: {
    summary: string;
    detail_lines?: string[];
    fee_usd?: number;
    provider?: string;
  };
  risk: {
    score: number;
    level: 'low' | 'medium' | 'critical';
    reasons?: string[];
  };
  execution: {
    mode: 'phantom_sign_and_send' | 'phantom_execute_then_optional_backend_proof';
    network: 'devnet' | 'mainnet-beta';
    expires_at: string;
  };
  timestamp: string;
};
```

```ts
type TransferProposal = {
  name: 'transfer';
  params: {
    amount: number;
    token: string;
    recipient: string;
    memo?: string;
  };
};

type ConditionalBuySolProposal = {
  name: 'conditional_buy_sol';
  params: {
    input_token: 'USDC';
    input_amount: number;
    target_price_usd: number;
    min_sol_out?: number;
  };
};
```

## Request contract

```ts
type ChatRequest =
  | {
      type: 'user_message';
      content: string;
      session_id?: string;
      user_address?: string;
      user_threshold_usd?: number;
    }
  | {
      type: 'function_approve';
      session_id: string;
    }
  | {
      type: 'function_result';
      session_id: string;
      tx_signature: string;
      status: 'submitted' | 'confirmed' | 'failed';
      error_message?: string;
    }
  | {
      type: 'function_reject';
      session_id: string;
      reason?: string;
    };
```

`function_result` es opcional para ejecucion on-chain. Sirve para registrar resultado o permitir que el chat responda con un mensaje final, pero no participa en la ejecucion de la transaccion.

## Approve response contract

Para `transfer`, `function_approve` devuelve:

```ts
type ApproveTransferResponse = {
  messages: AgentMessage[];
  proposal_state: {
    state: 'awaiting_signature';
    expires_at: string;
  };
  transaction: {
    format: 'base64_versioned_transaction';
    unsigned_tx_base64: string;
    recent_blockhash: string;
    last_valid_block_height: number;
    network: 'devnet' | 'mainnet-beta';
  };
};
```

No debe devolver `status: "success"` de ejecucion en este paso. Solo indica que la transaccion esta preparada para firma/envio en Phantom.

## Frontend wallet boundary

`front/src/hooks/useWallet.ts` o un helper cercano debe exponer capacidad de ejecucion:

```ts
type PhantomExecutionResult = {
  tx_signature: string;
};

type SignAndSendPreparedTransaction = (
  unsignedTxBase64: string,
) => Promise<PhantomExecutionResult>;
```

Responsabilidades:

- deserializar `VersionedTransaction` desde `unsigned_tx_base64`
- verificar que la wallet conectada coincide con el `user_address` del proposal
- llamar a Phantom `signAndSendTransaction`
- devolver `tx_signature`
- mapear errores: Phantom no instalado, desconectado, rechazo de usuario, cuenta cambiada, blockhash vencido

## Backend state

Backend mantiene `pendingProposal` por `session_id` para demo, extendido con:

- `proposal_type`
- `state`
- `expires_at`
- `expected_user_address`
- `network`
- `recent_blockhash`
- `last_valid_block_height`

No necesita guardar `signed_tx_base64`.

Puede guardar opcionalmente:

- `tx_signature` recibida por `function_result`
- estado reportado por frontend
- timestamp de resultado

## Proposal ID

Esta spec no usa `proposal_id`.

El contrato asume que `session_id` identifica una unica `pendingProposal` activa. Por lo tanto:

- `function_approve` aprueba la proposal activa de esa sesion
- `function_reject` cancela la proposal activa de esa sesion
- `function_result` opcional reporta resultado para la proposal activa o recientemente enviada de esa sesion
- backend debe responder `no_pending_proposal` si no hay proposal activa
- backend debe responder `proposal_expired` si la proposal activa vencio
- backend no debe permitir mas de una proposal activa por sesion

Si el producto incorpora proposals concurrentes o historial interactivo de approvals en el futuro, se debe reabrir la decision y agregar un identificador explicito.

## State machine

```txt
awaiting_approval
  -> preparing_transaction   when user approves in UI
  -> cancelled               when user rejects in UI
  -> failed                  when proposal is expired or mismatched

preparing_transaction
  -> awaiting_signature      when backend returns unsigned tx
  -> failed                  when backend cannot prepare tx

awaiting_signature
  -> submitted               when Phantom returns tx_signature
  -> cancelled               when user rejects Phantom prompt
  -> failed                  when wallet mismatch, malformed tx, or expired blockhash

submitted
  -> confirming              if frontend performs confirmation polling
  -> confirmed               if execution result is accepted immediately for demo
  -> failed                  if send fails

confirming
  -> confirmed               when transaction is confirmed
  -> failed                  when confirmation fails or times out
```

## Conditional buy

`conditional_buy_sol` should follow the same custody rule: Phantom executes in frontend.

If backend verification is required, the frontend sends only:

```ts
{
  type: 'function_result',
  session_id: string,
  tx_signature: string,
  status: 'submitted' | 'confirmed' | 'failed'
}
```

Backend verification, if implemented, must validate the signature against the specific proposal semantics:

- expected signer
- expected network/cluster
- expected guard program id
- expected instruction discriminator
- expected accounts/PDA or nonce
- expected input amount, target price, and min output
- chain success status
- proof not reused for another proposal

## Error codes

```ts
type ApiErrorCode =
  | 'session_not_found'
  | 'no_pending_proposal'
  | 'proposal_not_found'
  | 'proposal_expired'
  | 'proposal_state_conflict'
  | 'wallet_mismatch'
  | 'tx_build_failed'
  | 'phantom_signature_required'
  | 'blockhash_expired'
  | 'function_result_invalid'
  | 'onchain_verification_failed';
```

Frontend local errors additionally cover:

- Phantom not installed
- Phantom disconnected
- user rejected signature
- account changed during signing
- send failed
- confirmation timeout

## Implementation notes

- Remove any contract that requires frontend to send `signed_tx_base64` to backend for transfer.
- Frontend schemas must accept backend proposals `transfer` and `conditional_buy_sol`.
- `useAgentMessage` must not mark success after initial approve.
- Success for transfer comes from Phantom returning `tx_signature` and optional confirmation.
- Backend can receive `function_result`, but the transaction has already been sent by Phantom.

## Verification

- Approve response tests prove backend returns unsigned tx and `awaiting_signature`, not success.
- Frontend tests prove initial approve does not mark confirmed.
- Frontend tests prove Phantom signature rejection maps to `cancelled`.
- Frontend tests prove `tx_signature` marks `submitted`/`confirmed` depending on confirmation strategy.
- Contract tests prove no `signed_tx_base64` field is required or accepted for transfer execution.
