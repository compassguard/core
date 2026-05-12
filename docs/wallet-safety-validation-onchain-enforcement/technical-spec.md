# Technical Spec - Wallet Safety Validation On-Chain Enforcement

Version: 1
Status: Planned
Date: 2026-05-09
Feature: `wallet-safety-validation-onchain-enforcement`

## Decisión de Arquitectura

### Alternativas evaluadas

1. Extender `AgentActionGuard`
2. Crear un programa nuevo `WalletSafetyGuard`
3. Mantener la transferencia directa y agregar solo un patrón de attestation/oracle account sin enforcement de movimiento

### Decisión recomendada

Reutilizar y extender `AgentActionGuard` para el MVP.

### Justificación

- Reduce superficie de deploy y de upgrade para una demo ya alineada con el programa existente.
- Reutiliza `UserPolicy`, `ActionApproval`, expiración, revocación y la semántica actual de `action_hash`.
- Mantiene una sola línea histórica de approvals en cadena.
- El cambio de comportamiento crítico es agregar enforcement real al movimiento de fondos, no introducir otro programa de gobernanza.

### Razones para no elegir las otras opciones en MVP

- `WalletSafetyGuard` separa mejor concerns, pero agrega otra autoridad, otro IDL, otra historia de despliegue y más costo operativo antes de validar el flujo.
- El patrón de attestation sin `guarded_transfer` no resuelve el bypass principal porque el envío seguiría ocurriendo fuera del programa.

### Límite explícito de esta decisión

Si luego el programa empieza a absorber custody compleja, múltiples assets o reglas muy distintas por feature, conviene reevaluar una separación programática. Para este MVP el scope sigue siendo acotado a transferencias SOL con enforcement de safety.

## Arquitectura Propuesta

Referencia de dependencia:

- El detalle program-only de `guarded_transfer`, `WalletSafetyAttestation`, modelo de attestors, Anchor tests e IDL asociado vive en `docs/agent-action-guard-guarded-transfer/`.
- Este spec mantiene la propiedad del flujo end-to-end e integración runtime; no duplica la definición fina del programa.

### Componentes

- Programa Solana: `back/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs`
- Servicio backend de preparación/verificación: `back/services/chat.ts`
- Servicio backend de verificación on-chain: `back/services/onchainApproval.ts`
- Tool de transferencia y scoring: `back/services/tools/transfer.ts`
- Estado de proposal: `back/services/chatSessionStore.ts`
- Contratos frontend API: `front/src/lib/api/client.ts`, `front/src/lib/api/schemas.ts`, `front/src/types/api.ts`
- UI de proposal: `front/src/components/chat/proposals/SendProposalCard.tsx`, `front/src/hooks/useAgentMessage.ts`, `front/src/hooks/useWallet.ts`

### Modelo lógico

1. Backend produce un `action_hash` canónico para una transferencia concreta.
2. Backend crea o garantiza existencia de `ActionApproval`.
3. Backend crea o garantiza existencia de una `WalletSafetyAttestation` PDA emitida por un attestor autorizado.
4. Backend devuelve al frontend una tx unsigned de `guarded_transfer`.
5. El usuario firma y envía.
6. El programa valida cuentas y parámetros, hace la transferencia vía CPI y marca `ActionApproval.executed = true`.
7. La verificación posterior del backend lee cuentas on-chain, no solo logs.

Nota de alcance:

- Solscan permanece como input `indexed/off-chain` del feature `wallet-safety-validation`.
- El programa no consulta Solscan directamente.
- Si la validación indexada de Solscan debe impactar enforcement on-chain, esa señal entra únicamente resumida en la `WalletSafetyAttestation`/PDA o mecanismo equivalente hash-bound.

## Diseño On-Chain

### Nuevas cuentas

#### `WalletSafetyAttestation`

Cuenta PDA nueva dentro de `AgentActionGuard`.

Campos mínimos propuestos:

- `user: Pubkey`
- `recipient: Pubkey`
- `action_hash: [u8; 32]`
- `risk_decision: u8`
- `risk_score: u16`
- `attestor: Pubkey`
- `issued_at: i64`
- `expires_at: i64`
- `report_hash: [u8; 32]`
- `bump: u8`

Propósito:

- unir la validación off-chain con una cuenta verificable on-chain
- permitir expiración corta de reputación dinámica
- evitar requerir una segunda firma en la tx del usuario

### PDA seeds

#### `UserPolicy`

- `["user_policy", user_pubkey]`

#### `ActionApproval`

- `["action_approval", user_pubkey, action_hash]`

#### `WalletSafetyAttestation`

- `["wallet_safety_attestation", user_pubkey, recipient_pubkey, action_hash]`

Esta seed liga la attestation al usuario, destino y acción exacta. Evita reutilizar una validación vieja para otra transferencia.

## Instrucciones On-Chain

### Instrucciones existentes a conservar

- `initialize_policy`
- `update_policy`
- `create_action_approval`
- `revoke_action_approval`
- `mark_executed`
- `mark_executed_if_price_below`

### Instrucciones nuevas propuestas

#### `upsert_wallet_safety_attestation`

Uso:

- creada por attestor/oracle autorizado o por una autoridad backend controlada por esa clave
- se ejecuta antes de `guarded_transfer`

Validaciones:

- signer debe pertenecer al set autorizado configurado por programa o config PDA
- `expires_at > now`
- `action_hash` debe corresponder a una acción transferible
- `recipient` y `user` deben venir explícitos

Notas:

- En MVP conviene soportar create/update idempotente para reemitir attestation sin proliferar cuentas.

#### `guarded_transfer`

Inputs funcionales:

- `action_hash`
- `amount_lamports`
- `recipient`

Cuentas mínimas:

- `user: Signer`
- `user_policy`
- `action_approval`
- `wallet_safety_attestation`
- `recipient_system_account`
- `system_program`

Validaciones obligatorias:

- `user_policy.user == user`
- `user_policy.enabled == true`
- `action_approval.user == user`
- `action_approval.action_hash == action_hash`
- `action_approval.action_type == TransferSol`
- `action_approval.recipient == recipient`
- `action_approval.input_amount == amount_lamports`
- `action_approval` no expirado, no revocado, no ejecutado
- `wallet_safety_attestation.user == user`
- `wallet_safety_attestation.recipient == recipient`
- `wallet_safety_attestation.action_hash == action_hash`
- `wallet_safety_attestation.expires_at > now`
- `wallet_safety_attestation.risk_decision` compatible con execution permitida
- opcional MVP: recipient no executable si se pasa `AccountInfo` y se inspecciona owner/flags

Efectos:

- CPI a `SystemProgram::transfer`
- set `action_approval.executed = true`

### Configuración adicional recomendada

Agregar un config PDA simple para:

- `admin`
- `authorized_attestors: Vec<Pubkey>` o capacidad equivalente acotada
- `paused`

No es necesario convertir esta config en framework completo; solo debe permitir rotar la autoridad de attestation sin hardcodear todo en el binario.

## Modelo de Attestation

### Decisión MVP

Usar attestation account persistida en PDA y no una cofirma del oracle dentro de la tx del usuario.

### Motivo

- preserva el requisito `Phantom-first`
- permite que el backend devuelva una tx unsigned de una sola firma del usuario
- evita depender de partial signing complejo en cada approve
- deja trazabilidad auditable de la evaluación dinámica

### Contenido semántico de `report_hash`

`report_hash` debe resumir de forma canónica la evidencia off-chain usada para la decisión, por ejemplo:

- recipient
- network
- proveedor(es) usados
- blocklist version
- risk flags materiales
- timestamp de evaluación

No hace falta almacenar el reporte completo on-chain. El backend puede persistir el detalle off-chain y usar `report_hash` para correlación.

## Contrato de `action_hash`

### Regla

El backend debe usar serialización canónica JSON y `sha256`.

### Payload canónico mínimo para transfer SOL

```json
{
  "action_type": "TRANSFER_SOL_GUARDED",
  "network": "devnet",
  "user": "<user_pubkey>",
  "recipient": "<recipient_pubkey>",
  "amount_lamports": 100000000,
  "policy_pda": "<user_policy_pda>",
  "expires_at": 1778359200
}
```

### Reglas de compatibilidad

- `action_hash` debe ser idéntico en proposal, `ActionApproval`, `WalletSafetyAttestation`, instrucción `guarded_transfer` y verificación backend.
- Cambiar recipient, amount, network o expiry implica otro hash y otro approval.
- El frontend no recalcula el hash; solo consume el contrato del backend.

## Backend Integration

### Preparación de proposal

`back/services/tools/transfer.ts` sigue siendo dueño del análisis de negocio y riesgo, pero ahora debe producir metadata suficiente para:

- `action_hash`
- expiry de approval
- expiry de attestation
- razón de `WARN` o `REJECT`
- hints de enforcement on-chain

### `function_approve`

`back/services/chat.ts` debe cambiar de preparar una tx directa con `SystemProgram.transfer` a preparar una tx `guarded_transfer`.

Contrato esperado:

- mantiene `unsigned_tx_base64`
- mantiene `proposal_state.awaiting_signature`
- agrega metadata opcional para depuración/UI:
  - `guard_program_id`
  - `action_hash`
  - `approval_pda`
  - `attestation_pda`

### Verificación posterior

`back/services/onchainApproval.ts` debe dejar de validar solo:

- que la tx esté confirmada
- que exista una instrucción del programa en logs

Y pasar a validar además:

- lectura del `ActionApproval` PDA derivado
- `executed == true`
- `user`, `recipient`, `input_amount`, `action_hash`, `expires_at` consistentes
- lectura del `WalletSafetyAttestation` PDA esperado
- attestation vigente y consistente con la acción

Esta verificación debe ser determinística y fallar si solo hay invocación del programa pero no mutación correcta de cuentas.

## Frontend Integration

### Requisitos

- mantener el flujo actual de Phantom para firma/envío
- no introducir backend-submitted signed tx
- mostrar enforcement on-chain como parte del proposal

### Cambios funcionales

- `SendProposalCard` debe mostrar que la ejecución usa guardrail on-chain
- `useAgentMessage.ts` debe mapear errores de approval/attestation expirada o mismatch
- `useWallet.ts` sigue deserializando y firmando la tx devuelta por backend sin cambios de custodia

## Migración desde el flujo actual

### Antes

- backend hace scoring off-chain
- `function_approve` prepara `SystemProgram.transfer`
- verificación posterior mira confirmación e invocación de programa de forma débil o indirecta

### Después

- backend hace scoring off-chain
- backend crea/reutiliza `ActionApproval`
- backend crea/reutiliza `WalletSafetyAttestation`
- `function_approve` prepara `guarded_transfer`
- frontend firma/envía con Phantom
- backend verifica lectura de PDAs mutados

### Compatibilidad

- el flujo viejo de transfer directa debe quedar deshabilitado para la feature protegida
- si hay rollout progresivo, debe quedar detrás de flag explícita y nunca mezclarse silenciosamente

## Testing Strategy

Influencias tomadas de Solana Skills oficiales:

- `Testing Strategy`: pirámide con unit, instruction-level e integración
- `Security Checklist`: validación estricta de cuentas, signer checks y replay
- `IDL & Client Code Generation`: usar generación tipada del cliente/IDL cuando se implemente
- patrones frontend: mantener una sola frontera de wallet y transacción preparada por backend

### Capas mínimas

1. Unit tests del programa
2. Tests de instrucción/integración Anchor para `guarded_transfer`
3. Tests backend de derivación y verificación de PDAs
4. Tests frontend de contrato approve y mapeo de estados

### Casos mínimos

- `guarded_transfer` success con approval y attestation válidos
- falla por `action_hash` mismatch
- falla por approval expirado
- falla por approval revocado
- falla por approval ya ejecutado
- falla por attestation ausente
- falla por attestation expirada
- falla por recipient distinto
- falla por amount distinto
- verify service detecta tx confirmada pero PDA no ejecutado

## Security Checklist

- Validar signer del usuario en `guarded_transfer`.
- Validar todas las cuentas por seeds/bump y no por confianza implícita.
- No aceptar recipient ni amount solo desde instruction args; deben coincidir con `ActionApproval`.
- No reutilizar attestation entre hashes distintos.
- Marcar `executed` dentro de la misma instrucción que mueve fondos.
- Rechazar approvals expirados, revocados o ya usados.
- Rechazar attestations expiradas.
- Limitar la autoridad que puede crear/update attestations.
- No considerar logs/eventos como source of truth.
- Mantener la tx del usuario de una sola firma y sin custodia backend.

## Riesgos Técnicos

- Extender `AgentActionGuard` demasiado puede mezclar concerns y dificultar upgrades futuros.
- Un esquema pobre de canonicalización del `action_hash` puede romper compatibilidad entre backend y programa.
- Attestations con TTL demasiado corto pueden degradar UX; demasiado largo reduce valor de seguridad.
- Si la autoridad de attestation queda mal gestionada, el programa se vuelve tan confiable como esa llave.
- Verificar cuentas on-chain correctamente puede requerir refactor de cómo el backend almacena estado temporal de proposal.

## Verificación de Implementación

- El programa compila con las nuevas cuentas e instrucciones.
- Existe un flujo de approve que devuelve una tx `guarded_transfer`, no una transferencia directa.
- `onchainApproval.ts` deriva y lee PDAs esperados en lugar de depender de logs.
- La UI muestra estados y errores específicos del enforcement on-chain.
- Las pruebas cubren replay, expiración, mismatch y camino feliz.
