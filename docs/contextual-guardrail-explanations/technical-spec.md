# Especificación Técnica — Contextual Guardrail Explanations

**Versión:** 0.1  
**Fecha:** 2026-05-12  
**Estado:** Draft para revisión  
**Feature:** `contextual-guardrail-explanations`

## 1. Objetivo técnico

Definir un contrato y una arquitectura incremental para explicaciones contextuales de guardrails en la app Solana, preservando tres invariantes:

1. Las operaciones críticas siguen pasando primero por guardrails.
2. El backend/rules engine es la fuente de verdad de hechos y decisiones.
3. El frontend y el agente solo presentan o narran hechos ya emitidos por backend.

## 2. Estado actual relevante

### 2.1 Frontend

- `front/src/components/chat/proposals/RiskInlineAlert.tsx`
  - Renderiza razones de wallet safety.
  - Traduce reason codes a copy de usuario.
  - Muestra “Chequeos realizados”.

- `front/src/components/chat/proposals/SendProposalCard.tsx`
  - Muestra metadata de transferencia.
  - Explica la validación por contrato activa.
  - Renderiza `RiskInlineAlert`.

- `front/src/components/chat/proposals/SwapGuardWarning.tsx`
  - Explica desviación de precio contra oráculo.

- `front/src/components/chat/proposals/SwapGuardBypassWarning.tsx`
  - Explica rechazo de guard de precio y ofrece cancelar o ejecutar sin protección.

- `front/src/components/chat/proposals/ConditionalBuyProposalCard.tsx`
  - Muestra detalles operativos de conditional buy.
  - Reutiliza `RiskInlineAlert`, pero no tiene explicación específica del estado condicional.

- `front/src/lib/api/schemas.ts`
  - Define Zod schemas para `risk`, `walletSafety`, `swap_guard`, `swap_guard_warning`, `guard_rejection` y mensajes de agente.

### 2.2 Backend

- `back/services/chat.ts`
  - Crea proposals y approve responses.
  - En transferencias, adjunta `risk.walletSafety` y `onchain_guardrail`.
  - En swaps, adjunta `swap_guard`, `swap_guard_warning` y `guard_rejection`.

- `back/services/walletSafetyValidation.ts`
  - Produce decisiones `ALLOW | WARN | REJECT` y reason codes para seguridad de wallet destino.

- `back/services/tools/swapGuard.ts` y `back/services/tools/swapGuardOnChain.ts`
  - Calculan/describen guardrails de precio para swap.

- `back/services/conditionalOrders.ts`
  - Expone razones observables de ejecución/no ejecución para órdenes condicionales.

## 3. Arquitectura propuesta

```text
backend guardrail decision
  -> normalized GuardrailExplanation facts
  -> API/Zod contract
  -> frontend progressive disclosure UI
  -> optional agent narrative constrained by facts
```

### 3.1 Responsabilidades

| Capa | Responsabilidad | No debe hacer |
|---|---|---|
| Backend/rules engine | Emitir hechos, decisión, razones, checks y fuentes | Delegar decisión al frontend o al agente |
| Frontend | Presentar resumen/detalles/técnico e i18n/copy | Inventar razones de seguridad |
| Agente | Parafrasear y enseñar con base en payload estructurado | Crear checks, scores o decisiones nuevas |
| On-chain program | Enforcement determinístico cuando aplique | Consultar APIs off-chain directamente |

## 4. Contrato de datos

### 4.1 Tipos base

```ts
type GuardrailActionType =
  | 'transfer'
  | 'swap'
  | 'conditional_order'
  | 'token_risk'
  | 'wallet_policy'
  | string;

type GuardrailDecision = 'ALLOW' | 'WARN' | 'REJECT';

type GuardrailSeverity = 'info' | 'warning' | 'critical';

type ExplanationCategory =
  | 'destination_trust'
  | 'token_or_protocol_safety'
  | 'price_or_execution_risk'
  | 'permission_scope'
  | 'user_policy'
  | 'network_or_provider_state'
  | 'onchain_enforcement';

type ExplanationSource =
  | 'local'
  | 'policy'
  | 'onchain'
  | 'offchain'
  | 'oracle'
  | 'onchain_approval'
  | 'simulation';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'error' | 'not_run';

type SuggestedUserAction =
  | 'continue'
  | 'cancel'
  | 'review_destination'
  | 'reduce_amount'
  | 'send_test_amount'
  | 'review_price'
  | 'adjust_slippage'
  | 'wait_and_retry'
  | 'request_review';
```

### 4.2 `GuardrailExplanation`

```ts
type GuardrailExplanation = {
  id: string;
  action_type: GuardrailActionType;
  decision: GuardrailDecision;
  severity: GuardrailSeverity;
  category: ExplanationCategory;
  summary: string;
  impact?: string;
  reason_codes: string[];
  reasons: Array<{
    code: string;
    message: string;
    category: ExplanationCategory;
    source: ExplanationSource;
    severity: GuardrailSeverity;
  }>;
  checks: Array<{
    check: string;
    label: string;
    status: CheckStatus;
    source: ExplanationSource;
    evidence?: Record<string, unknown>;
  }>;
  sources: Array<{
    provider: string;
    status: 'ok' | 'missing' | 'stale' | 'error';
    checked_at?: string;
  }>;
  suggested_user_action?: SuggestedUserAction;
  technical_details?: Record<string, unknown>;
  created_at: string;
};
```

### 4.3 Reglas de seguridad del contrato

- `evidence` y `technical_details` deben estar sanitizados.
- No incluir secretos, API keys, `.env`, private keys, seed phrases ni raw credentials.
- No incluir raw prompt del usuario en payload para narrativa LLM.
- No usar prose como interfaz primaria; los `code` y `reason_codes` son la interfaz estable.
- `summary` y `message` pueden ser copy inicial, pero la UI debe poder fallbackear por `code`.

## 5. Integración API por fase

## Fase 1 — Payload incremental

### 5.1 Zod schemas

Agregar en `front/src/lib/api/schemas.ts`:

```ts
const GuardrailExplanationSchema = z.object({
  id: z.string(),
  action_type: z.string(),
  decision: z.enum(['ALLOW', 'WARN', 'REJECT']),
  severity: z.enum(['info', 'warning', 'critical']),
  category: z.enum([
    'destination_trust',
    'token_or_protocol_safety',
    'price_or_execution_risk',
    'permission_scope',
    'user_policy',
    'network_or_provider_state',
    'onchain_enforcement',
  ]),
  summary: z.string(),
  impact: z.string().optional(),
  reason_codes: z.array(z.string()),
  reasons: z.array(z.object({
    code: z.string(),
    message: z.string(),
    category: z.string(),
    source: z.enum(['local', 'policy', 'onchain', 'offchain', 'oracle', 'onchain_approval', 'simulation']),
    severity: z.enum(['info', 'warning', 'critical']),
  })),
  checks: z.array(z.object({
    check: z.string(),
    label: z.string(),
    status: z.enum(['pass', 'warn', 'fail', 'error', 'not_run']),
    source: z.string(),
    evidence: z.record(z.unknown()).optional(),
  })),
  sources: z.array(z.object({
    provider: z.string(),
    status: z.enum(['ok', 'missing', 'stale', 'error']),
    checked_at: z.string().optional(),
  })),
  suggested_user_action: z.string().optional(),
  technical_details: z.record(z.unknown()).optional(),
  created_at: z.string(),
});
```

### 5.2 Attachment points

Agregar `explanation?: GuardrailExplanation` en:

- `RiskInfoSchema`
- `SwapGuardWarningSchema`
- `GuardRejectionSchema`

Opcional posterior:

- top-level `AgentMessageResponseSchema.explanations?: GuardrailExplanation[]`

No se recomienda top-level en fase 1 para evitar mayor plumbing.

### 5.3 Backend builders

Crear helpers puros, preferentemente en un archivo nuevo:

- `back/services/guardrailExplanations.ts`

Funciones sugeridas:

```ts
buildTransferGuardrailExplanation(input: {
  risk: TransferRiskInfo;
  walletSafety: WalletSafetyDecisionResult;
  onchainGuardrail?: TransferOnchainGuardrailMetadata;
  createdAt?: string;
}): GuardrailExplanation

buildSwapGuardWarningExplanation(input: {
  warning: SwapGuardWarning;
  swapGuard: SwapGuardConfig;
  createdAt?: string;
}): GuardrailExplanation

buildSwapGuardRejectionExplanation(input: {
  rejection: GuardRejection;
  createdAt?: string;
}): GuardrailExplanation
```

### 5.4 Backend integration points

- Transfer proposal creation:
  - `back/services/chat.ts` después de `assessTransferRisk(...)` y antes de emitir `proposal`.

- Swap warning response:
  - `back/services/chat.ts` al armar `swap_guard_warning`.

- Swap guard rejection response:
  - `back/services/chat.ts` al armar `guard_rejection`.

### 5.5 Backward compatibility

Todos los nuevos campos son opcionales. Clientes actuales deben seguir parseando respuestas antiguas.

## Fase 2 — UI compartida y taxonomía

### 5.6 Componentes nuevos

Crear:

- `front/src/components/chat/proposals/GuardrailExplanationCard.tsx`
- `front/src/components/chat/proposals/GuardrailExplanationDetails.tsx` si el componente principal crece demasiado.

Props sugeridas:

```ts
type GuardrailExplanationCardProps = {
  explanation: GuardrailExplanation;
  defaultExpanded?: boolean;
  showTechnicalDetails?: boolean;
};
```

### 5.7 Comportamiento visual

Resumen por defecto:

- Icono por severidad.
- Label de decisión.
- `summary`.
- `impact` si es `WARN` o `REJECT`.
- CTA textual según `suggested_user_action`.

Detalle expandible:

- Lista de reasons.
- Lista de checks.
- Lista de providers/sources.

Detalle técnico:

- `technical_details` sanitizado.
- Hashes, PDAs, program IDs, oracle feeds, deviation bps, expiry.
- Hidden by default.

### 5.8 Migración de componentes existentes

- `RiskInlineAlert.tsx`
  - Si `risk.explanation` existe, renderizar `GuardrailExplanationCard`.
  - Si no existe, usar comportamiento actual.

- `SwapGuardWarning.tsx`
  - Si `warning.explanation` existe, mostrarlo.
  - Mantener copy actual como fallback.

- `SwapGuardBypassWarning.tsx`
  - Si `guardRejection.explanation` existe, mostrarlo antes de botones.
  - Reforzar que bypass significa ejecutar fuera del guard de precio.

- `ConditionalBuyProposalCard.tsx`
  - Preparar slot para explanation cuando backend lo emita.

## Fase 3 — Narrativa del agente restringida

### 5.9 Servicio de narrativa

Agregar un helper opcional, default-off:

- `back/services/guardrailNarration.ts`

Contrato sugerido:

```ts
type GuardrailNarration = {
  summary: string;
  bullets?: string[];
  based_on: {
    explanation_id: string;
    reason_codes: string[];
    checks: string[];
    sources: string[];
  };
};
```

### 5.10 Reglas de generación

- Input: solo `GuardrailExplanation` sanitizado.
- Output: JSON estricto.
- No incluir `rawUserMessage`.
- No permitir nuevas reason codes.
- No permitir cambiar `decision`, `severity`, `score`, `requiresExtraConfirmation` ni `suggested_user_action`.
- Si falla, no bloquear operación.
- Si el output menciona un code/check/source que no existe en input, descartar.

### 5.11 Integración conversacional

El agente puede incluir una micro-explicación en mensajes tipo `text` o en un campo opcional de proposal:

```ts
type AgentMessage = {
  ...
  narration?: GuardrailNarration;
}
```

Recomendación: para fase 3 empezar con un campo `explanation.narration?` y no con mensajes autónomos, para mantener trazabilidad directa.

## 6. Mapeos por flujo

### 6.1 Transfer

Inputs disponibles:

- `risk.level`
- `risk.score`
- `risk.walletSafety.decision`
- `risk.walletSafety.reasons`
- `risk.walletSafety.sources`
- `onchain_guardrail`

Decision mapping:

- `ALLOW` -> `severity=info`
- `WARN` -> `severity=warning`
- `REJECT` -> `severity=critical`

Technical details:

- `action_hash`
- `policy_pda`
- `action_approval_pda`
- `wallet_safety_attestation_pda`
- `action_expires_at`
- `action_recipient`

### 6.2 Swap

Inputs disponibles:

- `swap_guard`
- `swap_guard_warning`
- `guard_rejection`

Decision mapping:

- warning de desviación no bloqueante -> `WARN`, `price_or_execution_risk`
- rejection bypassable -> `REJECT` técnico con `can_bypass=true` en details

Technical details:

- `oracle_feed`
- `quoted_price_usd_e8`
- `oracle_price_usd_e8`
- `deviation_bps`
- `warning_deviation_bps`
- `max_deviation_bps`
- `on_chain_enforcement`

### 6.3 Conditional order

Inputs disponibles o deseables:

- `observedExecutableReason`
- target price
- oracle age/confidence constraints
- expiration
- recipient
- execution mode

Decision mapping:

- condición todavía no cumplida -> `info`, `price_or_execution_risk`
- condición expirada -> `warning` o `critical` según acción disponible
- oracle stale/confidence bad -> `WARN`
- policy/guard failure -> `REJECT`

## 7. Testing strategy

### 7.1 Contract tests

Modificar/agregar tests en:

- `front/src/lib/api/__tests__/schemas.test.ts`
- `front/src/lib/api/__tests__/client.test.ts`

Casos:

- proposal con `risk.explanation` parsea correctamente.
- proposal sin `risk.explanation` sigue parseando.
- `swap_guard_warning.explanation` parsea.
- `guard_rejection.explanation` parsea.
- payload con fields desconocidos en `evidence` no rompe.

### 7.2 Backend unit tests

Agregar tests para builders:

- transfer `ALLOW`
- transfer `WARN`
- transfer `REJECT`
- swap warning
- swap rejection bypassable

Assertions:

- reason codes preservados.
- decision consistente.
- no secretos ni raw user text.
- technical details solo contienen allowlist de campos.

### 7.3 UI tests

Agregar o extender tests en componentes de proposals:

- resumen visible por defecto.
- detalles expandibles.
- technical details ocultos por defecto.
- fallback actual funciona sin explanation.

### 7.4 Narration tests fase 3

- output válido con codes existentes.
- output inválido se descarta.
- output que inventa code se descarta.
- timeout/fallo no bloquea proposal.

## 8. Política de seguridad y privacidad

- Nunca incluir secretos o credenciales.
- Nunca serializar `.env` ni config privada.
- Sanitizar `technical_details` con allowlist explícita.
- Tratar direcciones públicas y hashes como datos públicos pero sensibles para UX.
- No incluir texto libre del usuario en prompts de narración.
- Guardar narration como derivada y descartable, no como fuente de auditoría primaria.

## 9. Rollout recomendado

### Fase 1

- Cambios contractuales mínimos.
- Builders backend puros.
- UI fallback existente.
- Tests de schema/builders.

### Fase 2

- UI compartida.
- Migración gradual de componentes.
- Taxonomía común.
- Tests de UI.

### Fase 3

- Narrativa opcional default-off.
- Validación estricta de output.
- Microcopy conversacional.
- Instrumentación recomendada.

## 10. Riesgos técnicos

- **Schema drift:** backend y Zod pueden divergir.
- **Payload demasiado grande:** technical details deben ser compactos.
- **Hardcoded copy duplicada:** migrar gradualmente a componente común.
- **LLM overreach:** la narrativa puede inventar si no se valida estrictamente.
- **Confusión entre warning y bypass:** el UI debe diferenciar “seguir protegido” de “ejecutar sin protección”.

## 11. Criterios técnicos de aceptación

- `GuardrailExplanation` existe como contrato documentado.
- Los attachment points están definidos y son opcionales.
- La fase 1 no requiere refactor grande de UI.
- La fase 2 tiene componente compartido y fallback.
- La fase 3 no permite que LLM cambie decisiones.
- Los tests cubren backward compatibility.
- La documentación mantiene claro qué es fuente de verdad y qué es presentación.

## 12. Notas de implementación y readiness

Las decisiones operativas tomadas durante la implementación de P1 y la prueba local están registradas en:

- `docs/contextual-guardrail-explanations/implementation-notes.md`

Ese documento cubre:

- estado real de P1;
- setup local seguro de `.env`, `.env.local` y archivo `credentials` sin exponer secretos;
- gotcha de precedencia entre `WALLET_SAFETY_ATTESTOR_SECRET_KEY` y `WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE`;
- fix de campos de approval en blanco derivando PDAs determinísticas;
- checklist de readiness para P2 y P3.
