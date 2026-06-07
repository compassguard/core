# Especificación Técnica — Wallet Public-Key Safety Validation

**Versión:** 1.1  
**Fecha:** 2026-05-10  
**Estado:** Draft para implementación

## 1. Objetivo técnico

Diseñar un guardrail de validación de wallet destino para transferencias en Solana que se integre al flujo conversacional existente, produzca decisiones determinísticas `ALLOW | WARN | REJECT` y se ejecute antes de emitir una propuesta firmable por Phantom.

- `local`: validaciones sin red ni proveedores.
- `on-chain/RPC`: hechos obtenibles directamente de Solana.
- `indexed/off-chain`: señales derivadas o reputacionales.
- `on-chain program`: enforcement determinístico con `AgentActionGuard` solo para acciones que explícitamente requieran guarded execution.

## 2. Contexto actual

Estado observado en el worktree:

- `back/services/chat.ts` implementa el flujo de propuesta/aprobación con session store manual y Azure Responses API.
- `back/services/tools/transfer.ts` solo valida wallet origen, formato de `recipient` y monto.
- `back/services/onchainApproval.ts` ya verifica evidencia básica de invocación al programa `AgentActionGuard`.
- El runtime actual usa RPC de Solana, listas internas, sanciones/env y allowlist-denylist, pero no integra Solscan todavía.
- El estado actual de chequeos combina validaciones reales, checks condicionados por env y proveedores todavía mock/status-only.
- `back/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs` ya soporta `UserPolicy`, `ActionApproval` y control on-chain de parámetros hash-bound.
- `docs/transaction-logic/` define que las transacciones de usuario se firman y envían desde frontend con Phantom injected. El backend prepara unsigned transactions y no recibe `signed_tx_base64`.

La spec propone una arquitectura objetivo compatible con el backend actual y con la decisión Phantom-first de `transaction-logic`: wallet safety corre antes de `pendingProposal`; al aprobar una transferencia simple, el backend devuelve `unsigned_tx_base64`; el frontend firma y envía con Phantom. Como addendum, la spec también define una opinión textual LLM opcional y estrictamente secundaria, generada después de la decisión determinística y solo desde un payload sanitizado de checks.

## 3. Arquitectura propuesta

### 3.1 Flujo lógico

```text
intent_parse
-> normalize_transfer
-> validate_local_wallet
-> fetch_onchain_wallet_facts
-> fetch_offchain_wallet_signals
-> evaluate_user_policy
-> compute_wallet_safety_decision
-> create_pending_transfer_proposal
-> await_user_approval
-> prepare_unsigned_transfer
-> phantom_sign_and_send_in_frontend
-> optional_function_result_with_tx_signature
```

Para acciones guarded, se inserta un nodo adicional `verify_onchain_guard_approval` antes de preparar o aceptar la ejecución correspondiente. Ese nodo no forma parte del flujo obligatorio de `transfer` simple.

### 3.2 Componentes propuestos

- `TransferIntentParser`
  - Extrae `asset`, `amount`, `recipient`, `memo`.
- `WalletValidationLocalService`
  - Valida sintaxis, auto-transfer, canonicalización.
- `WalletValidationOnchainService`
  - Consulta RPC y clasifica hechos de cuenta.
- `WalletValidationIndexedService`
  - Obtiene reputación, abuso, historial y etiquetas si hay proveedores.
  - Debe consultar Solscan cuando esté configurado para validar indexación/evidencia básica del destinatario.
- `TransferPolicyService`
  - Evalúa reglas del usuario y reglas globales del producto.
- `WalletSafetyDecisionEngine`
  - Fusiona señales y produce `ALLOW | WARN | REJECT`.
- `WalletSafetyOpinionService`
  - Construye un payload sanitizado con checks ejecutados y genera una opinión corta opcional en JSON estricto.
  - Nunca puede mutar la decisión determinística ni los campos de riesgo ya calculados.
- `PendingActionStore`
  - Extiende el `pendingProposal` por `session_id` con decisión, fuentes, hashes y expiración; no introduce un segundo mecanismo de correlación.
- `OnchainApprovalVerifier`
  - Verifica `ActionApproval` y consistencia de `action_hash` solo para acciones que usan `AgentActionGuard`.

## 4. Matriz de validaciones

| Validación | Capa | MVP | Decisión sugerida | Observaciones |
|---|---|---:|---|---|
| Formato válido de public key | Local | Sí | `REJECT` | No requiere red |
| Dirección on-curve/off-curve | Local | Sí | `REJECT` para PDA no existente | Standard wallet debe poder firmar; PDA requiere flujo explícito |
| Destino distinto a origen | Local | Sí | `REJECT` o `WARN` configurable | Recomendada como `REJECT` en MVP |
| Monto positivo y token soportado | Local | Sí | `REJECT` | Ya parcialmente existente |
| Canonicalización de recipient | Local | Sí | N/A | Necesaria para hash estable |
| Cuenta RPC consultable | On-chain/RPC | Sí | `WARN` o `REJECT` según política | Si RPC falla, no aprobar silenciosamente |
| `executable=true` | On-chain/RPC | Sí | `REJECT` | Cuenta programa no debe recibir transfer user-to-wallet por defecto |
| `owner` y tipo de cuenta | On-chain/RPC | Sí | `WARN`/`REJECT` | Distinguir System Program, Token Program, Token-2022, PDA conocida |
| Cuenta inexistente | On-chain/RPC | Sí | `WARN` | En SOL puede ser destino válido; no bloquear por sí solo |
| `getSignaturesForAddress` tx count/edad | On-chain/RPC o indexed | Sí parcial | `WARN` | En MVP limitar a bucket simple para no encarecer |
| Solscan indexed recipient lookup | Indexed/Off-chain | Sí | `WARN` si falta indexación o falla el proveedor | Si está configurado, registrar `provider=solscan`; `not indexed` no puede terminar en `ALLOW` |
| `getTokenAccountsByOwner` / portfolio | On-chain/RPC o indexed | No | `WARN` débil | Más útil para token-risk que para transferencia SOL |
| Address poisoning/dusting | On-chain/RPC + heurística | No | `WARN` | Fase posterior; falsos positivos probables |
| Blocklist interna | Off-chain | Sí | `REJECT` | Fuente crítica |
| Allowlist del usuario | Off-chain | Sí | Ajusta score | Reduce fricción, no elimina controles duros |
| Denylist del usuario | Off-chain | Sí | `REJECT` | Fuente crítica |
| OFAC/sanciones | Off-chain cacheada | Sí | `REJECT` | Kill-switch legal; si fuente crítica falla, fail-closed para ejecución |
| HAPI Protocol | On-chain externo o REST | Sí si viable | `REJECT`/`WARN` | Preferir check server-side; on-chain solo si se integra como oracle/cuenta legible |
| Chainabuse | Off-chain API | Fase 2 | `REJECT` si verificado, si no `WARN` | Requiere API key/acceso partner |
| GoPlus malicious address | Off-chain API | Fase 2 | `REJECT`/`WARN` | Buena señal, pero combinar por cobertura Solana |
| Helius identity/funded-by/history | Indexed/Off-chain | Fase 2 | `WARN`/contexto | Labels, funding source, historial y transfers |
| Vybe counterparties/labels | Indexed/Off-chain | Fase 2 | `WARN`/contexto | Útil para contrapartes, CEX, sybil o smart money |
| SNS/ANS domain | On-chain registry o resolver | Fase 2 | Señal positiva leve | Ausencia neutral |
| SAS/Civic Pass | On-chain attestation con issuer off-chain | Fase 2 | Señal positiva fuerte | Ausencia neutral, no negativa |
| Estado/firma de `ActionApproval` | Programa on-chain | No para transfer simple | `REJECT` si la acción lo requiere | Obligatorio solo para guarded actions |
| Coherencia `action_hash` con params | Backend + programa on-chain opcional | Sí en backend | `REJECT` | Para transfer simple se valida contra pendingProposal; para guarded action también contra approval |
| Umbral de monto `max_transfer_lamports` | Backend + programa on-chain opcional | Sí en backend | `REJECT` | On-chain solo si la acción pasa por `AgentActionGuard` |

## 4.1 Inventario observado en el worktree: real vs mock/status-only

| Check o señal | Estado actual | Tipo | Notas |
|---|---|---|---|
| Parseo y canonicalización de `PublicKey` | Real | Local | Determinístico |
| `amount > 0` | Real | Local | Determinístico |
| Self-transfer | Real | Local | Determinístico |
| Warn/max transfer thresholds | Real | Policy/env | Dependen de config |
| Allowlist threshold policy | Real | Policy/env | Depende de config |
| Internal blocklist/allowlist/denylist | Real | Env estático | No proviene de proveedor live |
| Sanctioned wallets env list | Real | Env estático | Lista local, no lookup live |
| `getAccountInfo` | Real | RPC | Usa `SOLANA_RPC_URL` |
| Rechazo `executable=true` | Real | RPC | Hard reject |
| `account not found` | Real | RPC | Warning |
| Fallback cuando RPC falla | Real pero degradado | RPC/error path | Puede caer a `providerStatus=error` o rama mock/source actual |
| Solscan | Real si está habilitado | Red/off-chain | Warning por `missing` o `error` |
| HAPI | Mock/status-only | Off-chain | Sin reputación live |
| Chainabuse | Mock/status-only | Off-chain | Sin reputación live |
| GoPlus | Mock/status-only | Off-chain | Sin reputación live |
| `abuseReports` | No implementado | Off-chain | Siempre vacío hoy |
| Reputación externa consolidada | No implementado | Off-chain | No hay proveedor live actualmente |

## 5. Decisión y scoring

### 5.1 Modelo propuesto

```ts
type WalletSafetyDecision = 'ALLOW' | 'WARN' | 'REJECT';

type WalletRiskLevel = 'low' | 'medium' | 'critical';
```

La decisión no debe depender solo de un score agregado. Debe priorizar:

1. `hardRejects`
2. `policyRejects`
3. `warnings`
4. score/risk level para UX

### 5.2 Reglas mínimas

`REJECT` si ocurre cualquiera:

- `INVALID_PUBLIC_KEY`
- `RECIPIENT_OFF_CURVE_UNSUPPORTED`
- `RECIPIENT_EXECUTABLE`
- `RECIPIENT_BLOCKLISTED`
- `RECIPIENT_USER_DENYLISTED`
- `RECIPIENT_SANCTIONED`
- `RECIPIENT_CONFIRMED_ABUSE_MATCH`
- `USER_POLICY_TRANSFER_LIMIT_EXCEEDED`
- `ACTION_HASH_MISMATCH`
- `ONCHAIN_APPROVAL_INVALID` cuando la acción requiere `AgentActionGuard`

`WARN` si no hay `REJECT` y ocurre alguno:

- `RECIPIENT_ACCOUNT_NOT_FOUND`
- `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`
- `RECIPIENT_LOW_HISTORY`
- `PROVIDER_PARTIAL_FAILURE`
- `RECIPIENT_NOT_ALLOWLISTED_OVER_WARN_THRESHOLD`
- `LOW_CONFIDENCE_ABUSE_SIGNAL`
- `RECIPIENT_UNVERIFIED_NEW_WALLET`
- `RECIPIENT_DUSTING_OR_POISONING_PATTERN`

`ALLOW` cuando no existan reglas duras ni advertencias activas.

## 6. LangGraph: nodos y funciones requeridas

### 6.1 Estado compartido propuesto

```ts
type TransferGuardrailState = {
  sessionId: string;
  threadId: string;
  userWallet: string;
  rawUserMessage: string;
  transferIntent?: {
    asset: 'SOL' | 'SPL';
    amount: number;
    recipient: string;
    memo?: string;
  };
  localValidation?: LocalWalletValidationResult;
  onchainFacts?: OnchainWalletFacts;
  offchainSignals?: OffchainWalletSignals;
  policyEvaluation?: TransferPolicyEvaluation;
  decision?: WalletSafetyDecisionResult;
  pendingAction?: PendingTransferAction;
  guardApprovalProof?: {
    approvalPda?: string;
    executeTxSignature?: string;
  };
  preparedTransaction?: {
    unsignedTxBase64: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  };
  phantomExecutionResult?: {
    txSignature: string;
    status: 'submitted' | 'confirmed' | 'failed';
  };
};
```

### 6.2 Nodos propuestos

### `intent_parse`

- Reutiliza el LLM/tool routing para extraer parámetros de transferencia.
- Salida: `transferIntent`.

### `normalize_transfer`

- Normaliza token por defecto, amount y recipient.
- Calcula representación canónica para hashing.

Funciones:

- `normalizeTransferIntent(intent)`
- `buildCanonicalTransferParams(intent, userWallet, expiresAt)`

### `validate_local_wallet`

- Ejecuta validaciones sin IO.

Funciones:

- `isValidSolanaPublicKey(recipient)`
- `validateTransferShape(intent)`

### `fetch_onchain_wallet_facts`

- Consulta RPC/Helius para hechos de cuenta.

Funciones:

- `getRecipientAccountInfo(recipient)`
- `classifyRecipientAccount(accountInfo)`
- `getRecipientProgramOwner(recipient)`

### `fetch_offchain_wallet_signals`

- Consulta blocklists, allowlists, indexadores y proveedores reputacionales.

Funciones:

- `lookupInternalWalletLists(recipient, userWallet)`
- `lookupSanctionsLists(recipient)`
- `lookupSolscanIndexedRecipient(recipient)`
- `lookupHapiRisk(recipient)`
- `lookupChainabuseReports(recipient)`
- `lookupGoPlusMaliciousAddress(recipient)`
- `lookupIndexedWalletHistory(recipient)`
- `lookupWalletIdentitySignals(recipient)`
- `lookupWalletCounterpartySignals(recipient)`
- `lookupNameAndAttestationSignals(recipient)`

### `evaluate_user_policy`

- Evalúa monto, frecuencia, listas y threshold de warning/reject.

Funciones:

- `evaluateTransferPolicy({ userWallet, asset, amount, recipient })`

### `compute_wallet_safety_decision`

- Fusiona resultados en una decisión única.

Funciones:

- `computeWalletSafetyDecision(input)`
- `buildDecisionReasons(input)`
- `buildUiRiskSummary(input)`

### `generate_wallet_safety_opinion`

- Corre solo después de `compute_wallet_safety_decision` y antes de emitir la propuesta final al usuario.
- Vive en backend, en el flujo de creación de proposal de `back/services/chat.ts`.
- Solo se ejecuta para decisiones ya determinadas; no recalcula riesgo.
- Si falla, el flujo sigue sin `agentOpinion`.

Funciones:

- `buildWalletSafetyOpinionPayload(result)`
- `generateWalletSafetyOpinion(payload)`
- `validateWalletSafetyOpinionJson(output)`

### `create_pending_transfer_proposal`

- Genera `action_hash`, expiración y objeto persistible.
- Solo corre si decisión es `ALLOW` o `WARN`.
- Usa la misma correlación de `transaction-logic`: un único `pendingProposal` activo por `session_id`.
- El proposal debe incluir la metadata de wallet safety dentro del contrato de `risk`.

Funciones:

- `buildTransferActionHash(canonicalParams)`
- `createPendingTransferAction(result)`

### `await_user_approval`

- Pausa HITL.
- Requiere confirmación normal o reforzada según decisión.

### `prepare_unsigned_transfer`

- Construye la transacción unsigned para firma del usuario.
- Solo corre tras approval de UI válida y si la `pendingProposal` no está vencida.
- Para transfer simple no requiere `AgentActionGuard`.

Funciones:

- `prepareUnsignedTransferForPhantom(pendingProposal)`
- `assertPendingProposalMatchesCanonicalParams(pendingProposal)`

### `phantom_sign_and_send_in_frontend`

- Nodo conceptual ejecutado del lado frontend según `docs/transaction-logic/`.
- Deserializa `unsigned_tx_base64`, valida wallet conectada y llama a Phantom injected.
- Devuelve `tx_signature` o error local de Phantom.

### `optional_function_result_with_tx_signature`

- Callback opcional al backend con `tx_signature`/estado.
- Sirve para auditoría, continuidad del chat o verificación posterior.
- No participa en el envío on-chain de transferencias simples.

### `verify_onchain_guard_approval`

- Verifica approval PDA o `execute_tx_signature`.
- Debe comparar `action_hash`, `recipient`, monto y expiración.
- Solo aplica cuando `execution.mode` o el tipo de acción requiere `AgentActionGuard`.

Funciones:

- `verifyActionApprovalByHash(actionHash, userWallet)`
- `verifyApprovalExecutionProof(executeTxSignature)`

## 7. Contratos de datos

### 7.1 Resultado de validación local

```ts
type LocalWalletValidationResult = {
  valid: boolean;
  recipientCanonical: string;
  hardRejects: Array<{
    code: string;
    message: string;
  }>;
};
```

### 7.2 Hechos on-chain

```ts
type OnchainWalletFacts = {
  recipient: string;
  accountExists: boolean;
  executable?: boolean;
  ownerProgram?: string;
  lamports?: string;
  space?: number;
  accountCategory?: 'system_wallet' | 'program' | 'token_account' | 'pda_like' | 'unknown';
  fetchedAt: string;
  source: 'solana-rpc' | 'helius';
};
```

### 7.3 Señales off-chain

```ts
type OffchainWalletSignals = {
  recipient: string;
  internalLists: {
    onBlocklist: boolean;
    onUserDenylist: boolean;
    onUserAllowlist: boolean;
  };
  reputation: {
    severity: 'none' | 'low' | 'medium' | 'critical';
    reasons: Array<{ code: string; message: string }>;
  };
  solscan?: {
    status: 'ok' | 'missing' | 'error';
    indexed: boolean | null;
    hasHistory?: boolean | null;
    checkedAt?: string;
  };
  sanctions?: {
    matched: boolean;
    source: 'ofac' | 'opensanctions' | 'internal';
    checkedAt: string;
  };
  abuseReports?: Array<{
    provider: 'hapi' | 'chainabuse' | 'goplus' | 'webacy' | 'custom';
    severity: 'low' | 'medium' | 'critical';
    confidence: 'low' | 'medium' | 'high';
    verified: boolean;
    code: string;
  }>;
  history?: {
    txCountBucket?: 'none' | 'low' | 'medium' | 'high';
    estimatedAccountAgeBucket?: 'new' | 'recent' | 'established' | 'unknown';
  };
  identity?: {
    labels: Array<{ provider: 'helius' | 'vybe' | 'solanafm' | 'custom'; label: string; category?: string }>;
    names: Array<{ provider: 'sns' | 'ans'; name: string }>;
    attestations: Array<{ provider: 'sas' | 'civic'; type: string; valid: boolean }>;
  };
  providerStatuses: Array<{
    provider:
      | 'internal-list'
      | 'ofac'
      | 'solscan'
      | 'hapi'
      | 'chainabuse'
      | 'goplus'
      | 'helius'
      | 'vybe'
      | 'sns'
      | 'sas'
      | 'civic'
      | 'mock'
      | 'custom';
    status: 'ok' | 'missing' | 'stale' | 'error';
  }>;
};
```

### 7.4 Resultado final

```ts
type WalletSafetyDecisionResult = {
  decision: WalletSafetyDecision;
  riskLevel: WalletRiskLevel;
  hardReject: boolean;
  requiresExtraConfirmation: boolean;
  reasons: Array<{
    code: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    source: 'local' | 'onchain' | 'offchain' | 'policy' | 'onchain_approval';
  }>;
  sources: Array<{
    provider: string;
    status: 'ok' | 'missing' | 'stale' | 'error';
  }>;
  agentOpinion?: {
    summary: string;
    basedOn: {
      codes: string[];
      sources: Array<{
        provider: string;
        status: 'ok' | 'missing' | 'stale' | 'error';
      }>;
    };
    model?: string; // audit/debug only; never render in user-facing UI
    generatedAt: string;
  };
};
```

### 7.5 Integración con `ProposalEnvelope.risk`

El contrato de `transaction-logic` ya define `risk: { score, level, reasons }`. Wallet safety debe extenderlo sin romper compatibilidad:

```ts
type ProposalRisk = {
  score: number;
  level: 'low' | 'medium' | 'critical';
  reasons?: string[];
  walletSafety?: WalletSafetyDecisionResult;
};
```

Reglas de mapeo:

- `WalletSafetyDecisionResult.decision === 'REJECT'`: no se emite proposal.
- `WARN`: proposal emitido con `risk.walletSafety.requiresExtraConfirmation=true` y `risk.level` mínimo `medium`.
- Riesgo alto no bloqueante debe mapearse a `medium`; riesgo bloqueante o confirmado debe mapearse a `critical`.
- `ALLOW`: proposal emitido con `risk.walletSafety` y `risk.level` según score global.

### 7.6 Payload sanitizado para el LLM

```ts
type WalletSafetyOpinionInput = {
  decision: 'ALLOW' | 'WARN' | 'REJECT';
  riskLevel: 'low' | 'medium' | 'critical';
  requiresExtraConfirmation: boolean;
  checks: Array<{
    code: string;
    outcome: 'pass' | 'warn' | 'reject' | 'error' | 'not_available';
    source: 'local' | 'policy' | 'onchain' | 'offchain';
  }>;
  sources: Array<{
    provider: string;
    status: 'ok' | 'missing' | 'stale' | 'error';
  }>;
};
```

Restricciones:

- No incluir `rawUserMessage`.
- No incluir prompts del usuario, texto libre del chat ni instrucciones arbitrarias.
- No incluir secretos, API keys ni payloads crudos de proveedores.
- Limitar el input a señales ya computadas por el guardrail.

### 7.7 Salida estricta del LLM

```json
{
  "summary": "Texto corto para el usuario.",
  "basedOn": {
    "codes": ["RECIPIENT_NOT_INDEXED_ON_SOLSCAN"],
    "sources": [
      { "provider": "solscan", "status": "missing" }
    ]
  }
}
```

Reglas:

- JSON estricto, sin markdown ni texto extra.
- `summary` corto y neutral.
- `basedOn.codes` debe ser subconjunto de reason codes determinísticos.
- `basedOn.sources` debe ser subconjunto de `providerStatuses`/`sources` ya registrados.
- Si el JSON no valida, se descarta.

## 8. MVP vs fases posteriores

### 8.1 MVP recomendado

- Validación local de `PublicKey`.
- Rechazo conservador de PDA/off-curve no soportada.
- Self-transfer permitido; se evalúa con el resto de guardrails.
- RPC `getAccountInfo`.
- Rechazo de cuentas ejecutables.
- Blocklist/allowlist/denylist interna y por usuario.
- Solscan configurable como señal indexada obligatoria para no promover a `ALLOW` cuando falte evidencia básica del destinatario.
- OFAC/sanciones cacheado como kill-switch si se incorpora la fuente al repo/backend.
- Política de monto ligada a `UserPolicy` y backend.
- Persistencia de pending action con `action_hash`.
- Preparación de `unsigned_tx_base64` al aprobar desde UI.
- Firma y envío en frontend con Phantom injected, según `transaction-logic`.
- Estados `ALLOW | WARN | REJECT` visibles en SSE/UI.
- Opinión LLM opcional detrás de env, con fallback seguro a ausencia de opinión.

### 8.2 Fase posterior

- Heurísticas de historial y antigüedad con indexador.
- Etiquetas de exchange/bridge/program wallet.
- Reportes de abuso multi-proveedor.
- HAPI, Chainabuse, GoPlus, Helius y Vybe como proveedores configurables complementarios.
- SNS/ANS/SAS/Civic como señales positivas, no bloqueantes.
- Cache warming y background refresh.
- Política configurable por entorno y usuario.
- Distinción fina entre SOL transfer a system account vs token account.

### 8.3 Fase avanzada

- Attestation/oracle firmada para reputación externa.
- Enforcements on-chain adicionales para categorías de destino.
- Registro auditable de risk reports firmados.

## 9. Fail-open vs fail-closed

### 9.1 Política recomendada

- `local` y `on-chain approval`: `fail-closed`
- `RPC primaria`: `fail-closed` para emitir/preparar una transferencia, `WARN` para preview solo si existe fallback y la política lo permite
- `blocklist interna` y `denylist usuario`: `fail-closed`
- `proveedores reputacionales externos`: `fail-open-to-warn`, nunca `fail-open-to-allow`
- `Solscan` configurado: `fail-open-to-warn`, nunca `fail-open-to-allow`
- `LLM opinion`: `fail-open-to-omit`, nunca `fail-open-to-mutate`

### 9.2 Reglas concretas

- Si falla la validación local: `REJECT`.
- Si no se puede verificar el `pendingProposal`/hash canónico: `REJECT`.
- Si una acción requiere `AgentActionGuard` y no se puede verificar approval/hash: `REJECT`.
- Si falla RPC y no existe fuente equivalente confiable: no preparar ejecución; preview como `WARN` solo si producto decide permitirlo explícitamente.
- Si falla proveedor secundario de reputación: mantener `WARN`, no promover a `ALLOW`.
- Si Solscan está configurado y responde `not indexed` o `not found`: mantener al menos `WARN` con `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`.
- Si Solscan está configurado y falla por timeout, `429` o `5xx`: mantener al menos `WARN` con `PROVIDER_PARTIAL_FAILURE` y registrar `provider=solscan` con `status=error`.
- Solo permitir que Solscan reduzca warnings de bajo contexto cuando devuelva `status=ok`, `indexed=true` y no existan hard rejects ni warnings materiales de otra fuente.
- Si el LLM falla, timeoutea o responde JSON inválido: omitir `agentOpinion` y conservar la propuesta determinística original.
- Si el LLM responde contenido que intenta cambiar la decisión o agregar señales no presentes en el payload sanitizado: descartar la respuesta.

## 10. Estrategia de cache

### 10.1 Qué cachear

- `getAccountInfo(recipient)` por TTL corto.
- Consulta indexada de Solscan por TTL corto/medio.
- Señales indexadas y reputacionales por TTL medio.
- Listas internas/usuario por lectura consistente de request.

### 10.2 TTL recomendado

- RPC account facts: `15s - 60s`
- Solscan indexed lookup: `1m - 5m`
- Historial/indexado: `5m`
- Reputación externa: `5m - 15m`
- Blocklists internas: cache local corta o lectura directa si el store es rápido

### 10.3 Reglas de invalidez

- No reutilizar cache para `action_hash` ni approvals.
- Invalidar al cambiar `recipient`, `amount`, `asset`, `userWallet` o política.
- Registrar `fetchedAt` y `sourceStatus` para auditoría.

## 11. Dependencias y proveedores

### 11.1 Dependencias mínimas

- Solana RPC (`@solana/web3.js`)
- `AgentActionGuard` ya desplegado/configurado
- session/pending proposal store
- configuración explícita de Solscan si se habilita esta señal

### 11.2 Proveedores recomendados

- `solana-rpc`: fuente primaria de hechos determinísticos
- `solscan`: fuente indexada secundaria para presencia/historial básico del recipient
- `ofac/internal sanctions cache`: kill-switch de sanciones
- `hapi`: riesgo de direcciones maliciosas, vía on-chain/RPC o REST
- `chainabuse`: reportes de scams y fraude
- `goplus`: malicious address y threat intel
- `helius`: identity, funded-by, historial/transacciones
- `vybe`: counterparties y labeled wallets/programs
- `sns`/`ans`: nombres human-readable
- `sas`/`civic`: attestations o passes verificables
- `internal-list`: blocklist/allowlist/denylist
- `birdeye` u otro proveedor de portfolio solo si aporta señal real de wallet; si no, dejarlo fuera del MVP

### 11.3 Configuración y entorno

Variables mínimas a documentar o agregar en `.env.example` cuando se implemente:

- `SOLANA_RPC_URL`: endpoint RPC principal para `getAccountInfo` y chequeos on-chain.
- `WALLET_SAFETY_PROVIDER_MODE`: por ejemplo `internal-only`, `solscan`, `mock`.
- `WALLET_SAFETY_SOLSCAN_ENABLED`: habilita o apaga la consulta indexada a Solscan.
- `WALLET_SAFETY_SOLSCAN_BASE_URL`: base URL del proveedor Solscan si la integración no usa default interno.
- `WALLET_SAFETY_SOLSCAN_API_KEY`: credencial si el plan de Solscan la requiere.
- `WALLET_SAFETY_SOLSCAN_TIMEOUT_MS`: timeout operativo para evitar bloquear el flujo.
- `WALLET_SAFETY_AGENT_OPINION_ENABLED`: habilita la generación opcional de opinión LLM.
- `WALLET_SAFETY_AGENT_OPINION_MODEL`: modelo a usar para la opinión.
- `WALLET_SAFETY_AGENT_OPINION_TIMEOUT_MS`: timeout corto para no agregar latencia excesiva.

Nota: `.env.example` hoy no expone `SOLANA_RPC_URL`, variables `WALLET_SAFETY_*` ni configuración de Solscan. La implementación debe agregarlas o documentar explícitamente defaults seguros.

Nota: en este worktree no aparece un proveedor específico ya integrado para reputación de wallets destino. Solscan pasa a ser la fuente indexada prioritaria para este feature, pero la implementación futura debe seguir dejando explícito `providerMode: "mock" | "internal-only"` cuando esa integración no esté habilitada.

## 12. Límite de responsabilidades: programas Solana vs backend/off-chain

### 12.1 Qué debe quedar on-chain

En `AgentActionGuard` o programas equivalentes:

- `UserPolicy` con umbrales determinísticos.
- `ActionApproval` vinculada a `action_hash`.
- expiración, revocación y anti-replay.
- chequeos determinísticos de monto máximo y tipo de acción.
- opcionalmente, allowlist/denylist compacta del usuario si el costo y la UX de administración son aceptables.
- opcionalmente, validación de `recipient` exacto como parte de los parámetros hasheados.
- verificación de oracle on-chain solo cuando la señal esté disponible como cuenta/oracle verificable.

Para transferencia simple Phantom-first, estos controles on-chain no son requisito para preparar la unsigned transaction. El enforcement primario ocurre en backend antes del proposal y en Phantom/frontend al firmar/enviar.

### 12.2 Qué debe quedar off-chain

- reputación dinámica de wallets,
- verificación de indexación dinámica vía Solscan u otros indexadores,
- blocklists externas sujetas a actualización frecuente,
- análisis de historial,
- heurísticas de cuentas nuevas o sospechosas,
- clasificación basada en etiquetas/indexadores,
- degradación por disponibilidad de proveedores,
- generación de copy explicativo opcional vía LLM a partir de resultados ya sanitizados.

Estas señales cambian rápido, pueden requerir múltiples fuentes y no son razonables de recalcular dentro de un programa Solana por costo, disponibilidad y falta de acceso directo a APIs externas.

Phantom/Solflare blocklists quedan fuera del chequeo directo de wallets porque son listas de URLs/dApps. Sirven para validar destinos web o dApps con las que se interactúa, no para decidir si una public key de wallet es segura.

Solscan también queda fuera del programa on-chain: es una señal indexada/off-chain. Si en el futuro se quiere usarla para enforcement en cadena, debe entrar solo mediante attestation/oracle hash-bound, no por llamadas directas desde el programa.

### 12.3 Qué requeriría oracle/attestation para enforcement on-chain

- score reputacional de wallet,
- blocklist externa certificada,
- clasificación "wallet nueva" o "bajo historial",
- labels de exchange/bridge/protocolo,
- reportes de abuso de terceros.

Si se quiere enforcement on-chain de estas señales, se necesita:

- `WalletSafetyReport` canónico,
- hash del reporte,
- firma de un `oracleSigner` autorizado,
- ventana de frescura corta,
- verificación on-chain del signer o de una cuenta/oracle de attestation.

## 13. Cambios de implementación sugeridos

- Extender `back/services/tools/transfer.ts` para desacoplar preparación de transferencia de evaluación de riesgo.
- Incorporar un servicio nuevo tipo `back/services/walletSafetyValidation.ts`.
- Introducir tipos compartidos para `WalletSafetyDecisionResult`.
- Evolucionar `back/services/chat.ts` hacia nodos explícitos o adaptador tipo LangGraph.
- Extender el contrato de proposal definido en `docs/transaction-logic/technical-spec.md` para incluir `risk.walletSafety`.
- Mantener el flujo `function_approve -> unsigned_tx_base64 -> Phantom signAndSendTransaction` para transferencias simples.
- Extender verificación en `back/services/onchainApproval.ts` para leer/contrastar approval PDA solo en acciones guarded, no como dependencia de transfer simple.
- Agregar integración Solscan en `back/services/walletSafetyValidation.ts` con provider status explícito, reason codes estables y degradación controlada.
- Insertar la generación de `agentOpinion` en `back/services/chat.ts` después de `evaluateWalletSafety` y antes de emitir la proposal al stream.
- Mantener la UI como consumidora pasiva de `agentOpinion`, sin usarla para recalcular decisión.

## 14. Riesgos técnicos principales

- El backend actual no usa LangGraph real pese al SDD histórico; migrar sin romper SSE requiere cuidado.
- `getAccountInfo` no alcanza para reputación; puede dar falsa sensación de seguridad si no se etiqueta bien.
- Señales externas de wallet pueden ser ruidosas o directamente no estar disponibles para Solana.
- Solscan puede devolver `not indexed` para wallets nuevas o con baja actividad, lo que exige una política de warning estable para evitar `ALLOW` falsos.
- Si no se fija política clara de degradación, los fallos de proveedores pueden generar decisiones inconsistentes.
- El programa actual no valida reputación de destino y no debería intentar hacerlo sin oracle/attestation.
- La opinión LLM puede introducir wording excesivo o ambiguo si no se restringe a JSON corto y payload sanitizado.
- Una mala ubicación del paso LLM podría aumentar latencia del proposal si no se aplica timeout corto y fallback por omisión.

## 15. Verificación

- Unit tests de validación local.
- Unit tests del decision engine con matrices `ALLOW/WARN/REJECT`.
- Integration tests del flujo de propuesta con pending action y SSE.
- Integration tests del flujo `function_approve` que devuelve unsigned tx sin exigir approval on-chain para transfer simple.
- Integration tests de verificación `action_hash` + approval para acciones guarded.
- Casos negativos de proveedor caído y RPC caído.
- Casos de Solscan `ok`, `missing` y `error` con reason codes y provider statuses estables.
- Revisión manual de mensajes de UI para diferenciar `WARN` de `REJECT`.
- Tests unitarios del builder de payload sanitizado para confirmar que no pasa `rawUserMessage`.
- Tests unitarios del parser/validator de JSON de `agentOpinion`.
- Tests de integración para confirmar que `agentOpinion` no aparece cuando el flag está apagado, el timeout vence o el JSON es inválido.
- Tests de integración para confirmar que `agentOpinion` no cambia `decision`, `riskLevel`, `score` ni `requiresExtraConfirmation`.
