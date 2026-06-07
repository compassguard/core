# Implementation Notes — Contextual Guardrail Explanations

Estas notas complementan las specs funcional/técnica y registran decisiones tomadas durante la implementación y prueba manual de la fase 1.

## Estado actual

| Fase | Estado | Resumen |
|---|---|---|
| P1 — Explanation payload incremental | Implementada | Contrato `GuardrailExplanation`, builders backend puros, attachment points opcionales y tests de contrato/builders. |
| P2 — Shared explanation UI and taxonomy | Implementada | UI reusable de disclosure progresivo, migración explanation-first con fallbacks y tests focalizados. |
| P3 — Agent narrative constrained by payload | Implementada | Narración default-off, validación estricta anti-invención, fallback no bloqueante y render secundario. |

## P1 implementado

### Contrato y attachment points

Se agregó un payload estructurado opcional `GuardrailExplanation` en:

- `risk.explanation` para transfer proposals.
- `swap_guard_warning.explanation` para approve responses de swap con warning.
- `guard_rejection.explanation` para approve responses de swap rechazado/bypassable.

Todos los campos nuevos son opcionales para mantener compatibilidad con payloads históricos.

### Builders backend

El backend construye explanations con helpers puros en:

- `back/services/guardrailExplanations.ts`

Regla importante: los builders reutilizan hechos ya calculados; no hacen IO, RPC, fetch ni llamadas a proveedores externos.

### Tests de P1

Evidencia registrada:

- `npm run test:front -- front/src/lib/api/__tests__/schemas.test.ts front/src/lib/api/__tests__/client.test.ts`
- `npm run test:back -- back/services/__tests__/guardrailExplanations.test.ts back/services/__tests__/chat.test.ts`
- ESLint focalizado sobre archivos modificados.

`tsc --noEmit` global fue intentado, pero queda bloqueado por errores preexistentes en `front/src/components/layout/DesktopShell.test.tsx` relacionados con mocks sin `isResolved`; no pertenece a esta feature.

## Notas operativas de prueba local

### Archivos de entorno

Para probar el worktree aislado, Next dev necesita cargar la misma configuración local que el worktree principal.

Archivos copiados sin leer ni imprimir secretos:

- `.env`
- `.env.local`
- `credentials`

El log esperado de Next dev debe mostrar:

```text
- Environments: .env.local, .env
```

No commitear:

- `.env`
- `.env.local`
- `.env.*`
- `credentials`
- `app.log`
- `app.pid`
- `node_modules`

### Attestor key

El backend soporta dos formas de configurar la clave del attestor:

- `WALLET_SAFETY_ATTESTOR_SECRET_KEY`
- `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE`

Para evitar exponer la clave en `.env`, durante la prueba se prefirió la variante por archivo:

```text
WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE=<path-absoluto-al-archivo-credentials>
```

Gotcha: `parseAttestorKeypair()` prioriza `WALLET_SAFETY_ATTESTOR_SECRET_KEY` sobre `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE`. Si existe un valor directo inválido o placeholder, puede shadowear el archivo y terminar en `WALLET_SAFETY_ATTESTOR_SECRET_KEY_NOT_CONFIGURED`.

Mitigación usada en dev:

- remover entradas directas `WALLET_SAFETY_ATTESTOR_SECRET_KEY` del `.env` del worktree de prueba;
- dejar solo `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE`;
- arrancar Next sin heredar variables directas de attestor desde el shell.

### Program id público

`AGENT_ACTION_GUARD_PROGRAM_ID` debe estar configurado para transferencias guardrailed. La fuente canónica del program id devnet es:

- `docs/onchain-deployments.md`

## Fix de campos de aprobación en blanco

Durante la prueba manual se detectó que una approve response de transfer podía devolver campos de metadata on-chain vacíos si el `pendingProposal` rehidratado no traía PDAs derivadas.

Campos afectados:

- `action_approval_pda`
- `wallet_safety_attestation_pda`

Decisión:

- No serializar strings vacíos.
- Derivar las PDAs durante approve cuando falten, usando `user`, `recipient` y `actionHash`.

Archivos afectados:

- `back/services/chat.ts`
- `front/src/components/chat/proposals/SendProposalCard.tsx`

La UI también debe fallbackear con `—` si recibe params parciales o históricos.

## P2 implementado

### UI reusable de disclosure progresivo

Se agregó:

- `front/src/components/chat/proposals/GuardrailExplanationCard.tsx`

La card muestra por defecto:

- decisión con label estable `ALLOW`, `WARN` o `REJECT`;
- severidad/categoría;
- `summary`, `impact` y acción sugerida cuando existen.

Los detalles de razones, checks y fuentes son expandibles. `technical_details` queda oculto por defecto y requiere una acción explícita para verse.

### Migración con fallback legacy

Se migraron los attachment points existentes a un flujo explanation-first:

- `RiskInlineAlert` renderiza `GuardrailExplanationCard` cuando `risk.explanation` existe y conserva toda la copy legacy si no existe.
- `SwapGuardWarning` renderiza `warning.explanation` si viene y conserva el warning de desviación anterior como fallback.
- `SwapGuardBypassWarning` muestra `guardRejection.explanation` antes del copy de bypass, manteniendo botones y advertencia de ejecutar sin protección.
- `ConditionalBuyProposalCard` deja un slot explícito para la explicación de guardrail y sigue usando `RiskInlineAlert` para preservar fallback/configuración.

También se ajustó `front/src/stores/chatStore.ts` para que los estados locales de swap warning/rejection conserven `explanation` al venir desde el approve response.

### Mapping inicial de conditional orders

Se agregó `CONDITIONAL_ORDER_EXPLANATION_REASON_MAP` en:

- `back/services/conditionalOrders.ts`

El mapping documenta cómo proyectar `observedExecutableReason` a decisión/severidad/categoría/acción sugerida para un futuro builder de explanations, sin cambiar comportamiento de ejecución.

### Tests de P2

Evidencia registrada:

- `npm run test:front -- front/src/lib/api/__tests__/schemas.test.ts front/src/lib/api/__tests__/client.test.ts front/src/components/chat/proposals/__tests__/GuardrailExplanationCard.test.tsx`
- `npm run test:back -- back/services/__tests__/conditionalBuySol.test.ts`
- ESLint focalizado sobre archivos modificados de P2.

`npx tsc --noEmit` global fue intentado y sigue bloqueado únicamente por los errores preexistentes de `front/src/components/layout/DesktopShell.test.tsx` donde mocks de `useWallet` no incluyen `isResolved`.

## P3 implementado

### Contrato de narración segura

Se agregó `GuardrailNarration` como campo opcional dentro de `GuardrailExplanation` en:

- `front/src/types/api.ts`
- `front/src/lib/api/schemas.ts`
- `back/services/guardrailExplanations.ts`

El contrato referencia `explanation_id` y listas `based_on.reason_codes`, `based_on.checks` y `based_on.sources`. No incluye campos para modificar decisión, severidad, score ni acción sugerida.

### Servicio backend default-off

Se agregó:

- `back/services/guardrailNarration.ts`
- `back/services/__tests__/guardrailNarration.test.ts`

El servicio está deshabilitado por defecto y solo se activa con `GUARDRAIL_NARRATION_ENABLED=true` o con override explícito en tests. La entrada enviada al proveedor se construye desde una versión sanitizada de `GuardrailExplanation`:

- no incluye `rawUserMessage`;
- no incluye `technical_details`;
- no incluye `.env`, credentials, secrets ni config privada;
- solo usa hechos estructurados ya emitidos por backend.

La salida debe ser JSON estricto con claves `summary`, `bullets` y `based_on`. Se descarta si:

- no parsea como JSON objeto;
- trae claves no permitidas;
- intenta incluir/modificar `decision`, `severity`, `score`, `requiresExtraConfirmation`, `requires_extra_confirmation` o `suggested_user_action`;
- inventa reason codes, checks o sources no presentes en la explanation original;
- referencia otro `explanation_id`.

Si el proveedor falla o timeoutea, `attachGuardrailNarration` devuelve la explanation original sin bloquear proposal/approval.

### Integración y UI

Se integró `attachGuardrailNarration` en:

- transfer proposal explanations;
- swap guard warning explanations;
- swap guard rejection explanations.

Como la feature está default-off, los flujos actuales siguen sin llamada narrativa salvo configuración explícita.

`GuardrailExplanationCard` renderiza `narration` como ayuda contextual secundaria y explicita que la decisión oficial sigue siendo la del payload estructurado.

### Tests de P3

Evidencia registrada:

- `npm run test:back -- back/services/__tests__/guardrailNarration.test.ts back/services/__tests__/guardrailExplanations.test.ts back/services/__tests__/chat.test.ts`
- `npm run test:front -- front/src/lib/api/__tests__/schemas.test.ts front/src/lib/api/__tests__/client.test.ts front/src/components/chat/proposals/__tests__/GuardrailExplanationCard.test.tsx`
- ESLint focalizado sobre archivos P3.
- Revisión fresca con subagente reviewer: sin blockers.

`npx tsc --noEmit` global fue intentado. Los errores de tipos introducidos por P3 fueron corregidos; el comando sigue bloqueado únicamente por los errores preexistentes de `front/src/components/layout/DesktopShell.test.tsx` donde mocks de `useWallet` no incluyen `isResolved`.

## Próximo paso recomendado

Cerrar la feature con una revisión final/manual end-to-end y decidir si:

1. se deja `GUARDRAIL_NARRATION_ENABLED` apagado para demo segura;
2. se habilita temporalmente para probar narración con proveedor real;
3. se separa la entrega en PRs por P1/P2/P3 para reducir carga de review.
