# Functional Spec: Wave 3 — Transfer behind gateway

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-06-06
- **Estado:** Draft para implementación TDD
- **Feature:** `wave-3-transfer-behind-gateway`
- **Wave:** 3 (migración Compass MCP Guard v0)
- **Branch:** `feature/wave-3-transfer-behind-gateway`
- **Base:** `release/compass_migration`

## Resumen

Wave 3 integra el flujo existente de transferencia SOL con las primitivas ya creadas del **Compass MCP Guard**:

1. contratos de execution gateway de Wave 1 (`classifyToolCall`, `createActionCandidate`, `buildAuditEvent`);
2. policy engine conservador de Wave 2 (`loadDefaultPolicy`, `evaluateAction`);
3. guardrails existentes de transferencia: validación local, wallet safety, metadata on-chain, pending proposal, approval card y firma desde wallet en frontend.

La wave no cambia el modelo de signer: Compass sigue preparando una transacción no firmada y el usuario firma/envía con su wallet. El cambio funcional es que ninguna transferencia puede crear proposal ni construir unsigned tx sin pasar por clasificación, policy evaluation y auditoría estructurada.

## Objetivo de producto

Demostrar que Compass controla una acción mutante real antes de la firma:

> Cuando un agente prepara una transferencia SOL, Compass debe clasificar la tool call, construir un `ActionCandidate`, evaluar la policy default, preservar la aprobación humana y bloquear/fallar cerrado si la policy lo exige.

## Actores

| Actor | Rol |
| --- | --- |
| Usuario | Solicita transferencia y aprueba/rechaza desde la UI. |
| Agente/LLM | Propone la tool call `transfer`; no firma ni ejecuta. |
| Compass backend | Valida params, evalúa wallet safety, gateway/policy, crea proposals y construye unsigned tx. |
| Frontend wallet | Firma/envía la transacción solo después de aprobación Compass. |
| Audit consumer futuro | Consumirá eventos estructurados de proposal, approval, submission y result. |

## Comportamiento actual

- `back/services/chat.ts` recibe tool calls `transfer` desde intención directa o desde Azure Responses.
- `prepareTransferResult()` valida wallet origen, recipient, monto y token SOL.
- `evaluateWalletSafety()` aplica validaciones locales/on-chain/off-chain y puede `ALLOW`, `WARN` o `REJECT`.
- Si no hay rechazo, `chat.ts` crea metadata de guard on-chain, `PendingProposal`, approval card y SSE `proposal`.
- `function_approve` reconstruye canonical transfer, verifica `actionHash`, verifica readiness on-chain y construye unsigned transaction.
- El frontend firma/envía y reporta `function_result`.

## Comportamiento target

- Toda transferencia preparada por el agente MUST pasar por `classifyToolCall()` y `createActionCandidate()`.
- El backend MUST derivar un contexto de policy conservador para transfer: `amount_usd`, `recipient_address`, `recipient_known`, `token_mint`/token/action identifiers y flags de riesgo cuando existan.
- El backend MUST cargar/evaluar `defaultPolicy.yaml` antes de crear `PendingProposal` o construir unsigned tx.
- `DENY` MUST bloquear la creación de proposal con motivo claro.
- `REQUIRE_ADDITIONAL_CONTEXT` MUST fallar cerrado con motivo claro de evidencia faltante; no debe pedir firma.
- `REQUIRE_HUMAN_APPROVAL` MUST mapear al approval card actual.
- `ALLOW` SHOULD preservar el approval card en Wave 3 para no cambiar la experiencia ni el signer boundary.
- En `function_approve`, el backend MUST verificar que el gateway/policy metadata guardado sigue correspondiendo a la propuesta pendiente antes de construir unsigned tx.
- El backend SHOULD emitir eventos auditables estructurados para proposal, approval, submission/result y rejects, reutilizando contratos de Wave 1 cuando sea posible.

## Requerimientos funcionales

### R1 — Clasificación y candidate

- El flujo transfer MUST clasificar la tool call como acción sensible (`transfer`/`transfer_sol`) antes de proposal.
- El flujo transfer MUST crear un `ActionCandidate` de chain `solana`, network actual, actionKind `transfer`, actor wallet y params redacted.
- El candidate MUST incluir evidencia suficiente para auditoría sin exponer secretos ni prompt raw.

### R2 — Evaluación de policy

- El flujo transfer MUST evaluar `evaluateAction()` con `loadDefaultPolicy()` antes de crear `PendingProposal`.
- La decisión del policy engine MUST quedar asociada a la propuesta cuando se cree una proposal.
- La decisión MUST incluir `policyId`, `decision`, `reasonCodes` y `evaluatedRules`.
- La implementación MUST preservar la semántica existente de wallet safety y on-chain guard: un wallet safety `REJECT` sigue bloqueando.

### R3 — Derivación conservadora de contexto

- `amount_usd` MUST derivarse a partir del monto SOL y una fuente de precio disponible; si no se puede derivar de forma confiable, MUST omitirse y dejar que policy falle con `REQUIRE_ADDITIONAL_CONTEXT`.
- `recipient_address` MUST usar el recipient canonical de wallet safety cuando exista.
- `recipient_known` MUST derivarse de evidencia existente: allowlist/history/provider data cuando exista; si no hay evidencia positiva, SHOULD ser `false` para recipient desconocido o quedar ausente si la evidencia es insuficiente.
- Flags de riesgo MUST mapear desde wallet safety/off-chain signals cuando existan, por ejemplo suspicious recipient o blocked recipient.
- El token/action identifier MUST representar explícitamente SOL transfer (`token: SOL`, mint nativo/SOL devnet si existe en config, `actionKind: transfer`).

### R4 — Decisiones y UX

- `ALLOW` MUST seguir mostrando approval card en Wave 3; no hay auto-execution.
- `REQUIRE_HUMAN_APPROVAL` MUST mostrar el approval card actual con explicación/risk reasons.
- `DENY` MUST responder sin proposal con reason codes claros y acción sugerida.
- `REQUIRE_ADDITIONAL_CONTEXT` MUST responder sin proposal con reason codes claros y sugerencia de reintentar cuando haya precio/evidencia.
- `REQUIRE_SIMULATION` y `REQUIRE_POLICY_UPDATE`, si aparecen por configuración futura, MUST fallar cerrado en transfer Wave 3 salvo que exista handling explícito testeado.

### R5 — Approval-time integrity

- Al aprobar, el backend MUST recomputar o verificar un fingerprint determinístico del candidate/policy evaluation guardado.
- Si los args, wallet, policyId, decision, reason codes relevantes o action hash no coinciden, MUST bloquear con conflicto y limpiar/fallar la proposal según patrón existente.
- El backend MUST verificar esto antes de llamar a `buildUnsignedSolTransferTx()`.

### R6 — Auditoría

- El backend MUST crear eventos auditables para:
  - proposal created;
  - proposal denied/fail-closed;
  - approval received;
  - unsigned transaction prepared / awaiting signature;
  - function result submitted/confirmed/failed;
  - user reject.
- Los eventos MUST usar redaction rules de Wave 1 y no guardar prompts raw, secretos, auth headers ni raw tx completos.
- Wave 3 MAY mantener auditoría en memoria/estructura de sesión o logs estructurados; durable audit storage es non-goal salvo que ya exista soporte mínimo.

## Escenarios

### S1 — Policy ALLOW preserva approval card

Dado un usuario con wallet conectada y una transferencia SOL chica hacia recipient conocido, cuando Compass prepara la transferencia, entonces:

- clasifica la tool call;
- crea un `ActionCandidate`;
- evalúa policy y obtiene `ALLOW`;
- crea proposal y approval card igualmente;
- guarda metadata gateway/policy en la pending proposal;
- no construye unsigned tx hasta `function_approve`.

### S2 — REQUIRE_HUMAN_APPROVAL usa UX actual

Dado una transferencia sobre el umbral o hacia recipient desconocido, cuando policy devuelve `REQUIRE_HUMAN_APPROVAL`, entonces Compass crea el approval card actual con reason codes/risk explanation y mantiene el flujo de aprobación/firma existente.

### S3 — REQUIRE_ADDITIONAL_CONTEXT falla cerrado

Dado una transferencia sensible donde `amount_usd` o evidencia mínima de recipient no se puede derivar, cuando policy devuelve `REQUIRE_ADDITIONAL_CONTEXT`, entonces Compass no crea `PendingProposal`, no prepara unsigned tx y responde con una explicación clara de contexto faltante.

### S4 — DENY bloquea antes de proposal

Dado un recipient bloqueado o un flag de riesgo denegatorio, cuando policy devuelve `DENY`, entonces Compass bloquea la transferencia antes de crear proposal y registra un audit event de rechazo.

### S5 — Mismatch en approval bloquea unsigned tx

Dado una proposal transfer creada con metadata gateway/policy, cuando `function_approve` detecta que el hash/candidate/evaluation guardado no matchea los args o wallet actuales, entonces Compass limpia o marca fallida la proposal y responde `409 action_hash_mismatch` o un código equivalente específico de gateway mismatch. No debe llamar a `buildUnsignedSolTransferTx()`.

### S6 — Audit events cubren lifecycle

Dado una transferencia que llega a proposal y luego se aprueba, cuando el frontend reporta `submitted`, `confirmed` o `failed`, entonces Compass emite eventos auditables con candidateId, policyId, decision, approvalStatus/result y transactionSignature solo cuando exista.

## Pendiente arquitectónico (post Wave 3)

La implementación actual de Wave 3 cablea gateway/policy/audit dentro de `back/services/chat.ts`, que viene de la app anterior como entrypoint `/api/chat` + SSE + proposals + tools.

Esto contradice la dirección de producto en `docs/PRODUCT_CONSTITUTION.md` (Compass MCP Guard / execution firewall, no chatbot DeFi). El boundary real debería ser un tool/MCP gateway independiente, con `chat.ts` como adapter legacy temporal o retirado.

Wave 3 queda mergeada con esta deuda explícita: una migración posterior debe mover el flujo guarded transfer (y futuros swap/conditional) a un servicio dedicado de tool boundary, dejar `chat.ts` aislado en `legacy/` si ya no se usa, y reorientar los tests hacia ese boundary nuevo.

## Non-goals

- Migrar swaps detrás del gateway (Wave 4).
- Migrar conditional orders detrás del gateway (Wave 4).
- Cambiar el modelo de signer o mover private keys al backend (Wave 5+ explícito; no hacerlo aquí).
- Auto-ejecutar transfers con `ALLOW`; Wave 3 preserva approval card.
- Crear durable audit storage pesado/DB nueva si no existe soporte mínimo.
- Cambiar contratos on-chain del guard o redeploy de programas.
- Construir MCP server público/compat mode (Wave 6).

## Acceptance criteria global

- Tests backend RED→GREEN cubren ALLOW, REQUIRE_HUMAN_APPROVAL, REQUIRE_ADDITIONAL_CONTEXT, DENY y mismatch en approval.
- Existing transfer UX sigue mostrando proposal card y wallet signing.
- Ninguna transferencia puede construir unsigned tx sin approval y metadata gateway/policy verificada.
- Wallet safety/on-chain guard semantics existentes se preservan.
- Audit events estructurados existen para proposal, approval, reject/result paths con redaction.
- `npm run test:back` pasa.
- `npm test` pasa si se toca comportamiento frontend o contrato que consuma UI.
- `npm run lint` pasa por cambios runtime.
