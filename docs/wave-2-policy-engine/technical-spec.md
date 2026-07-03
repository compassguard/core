# Technical Spec: Wave 2 — Policy Engine v0

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-06-05
- **Estado:** Draft para revisión
- **Feature:** `wave-2-policy-engine`

## Arquitectura

```
┌──────────────────────────────────────────────────────────────┐
│ Wave 1 contracts (ya existen, no se tocan)                   │
│ - COMPASS_DECISIONS, TOOL_RISK_CLASSES                       │
│ - classifyToolCall(), createActionCandidate(), buildAuditEvent│
└──────────────────────────────────────────────────────────────┘
                          ▲
                          │ imports
                          │
┌──────────────────────────────────────────────────────────────┐
│ Wave 2 policy engine (esta spec)                             │
│ - defaultPolicy.yaml         → política YAML conservadora     │
│ - policyContracts.ts         → tipos/constantes contractuales │
│ - policySchema.ts            → validación de schema           │
│ - loadPolicy.ts              → parse + validate YAML          │
│ - policyEngine.ts            → evaluateAction() puro          │
│ - policyEvaluationResult.ts  → helpers puros de resultado     │
└──────────────────────────────────────────────────────────────┘
```

El engine **no se cablea** a `chat.ts` ni a tools concretas en esta wave.

## Archivos

| Path                                             | Líneas estimadas | Propósito                                                                |
| ------------------------------------------------ | ---------------: | ------------------------------------------------------------------------ |
| `back/services/policy/defaultPolicy.yaml`        |              ~55 | Política conservadora MVP (PRODUCT_CONSTITUTION §16).                    |
| `back/services/policy/policyContracts.ts`        |             ~140 | Tipos, outcomes y reason codes contractuales.                            |
| `back/services/policy/policySchema.ts`           |             ~210 | Validador `validateCompassPolicy()` y helpers privados.                  |
| `back/services/policy/loadPolicy.ts`             |              ~70 | Parse YAML + validate + cache. Expone `loadDefaultPolicy()`.             |
| `back/services/policy/policyEngine.ts`           |             ~220 | `evaluateAction()` con reglas read-only/transfers/swaps/signing/blocked. |
| `back/services/policy/policyEvaluationResult.ts` |              ~55 | Helpers puros para mapear outcomes y construir `PolicyEvaluation`.       |
| `back/services/__tests__/policyEngine.test.ts`   |             ~300 | TDD por outcome (≥18 tests).                                             |
| `back/services/__tests__/loadPolicy.test.ts`     |              ~80 | TDD de parse + validation + errores explicables.                         |
| **Total estimado**                               |         **~870** |                                                                          |

Sigue por encima del budget review de 400 LOC. Por eso el plan es **un solo PR con dos rondas de verificación**:

- **Ronda 1 (mid-checkpoint):** schema + loader + YAML + sus tests (~295 LOC). Tests + lint verdes.
- **Ronda 2 (final):** policy engine + outcome tests (~520 LOC). Tests + lint verdes.

## Tipos canónicos

```ts
// back/services/policy/policyContracts.ts

import type {
  CompassDecision,
  ToolClassification,
  ActionCandidate,
} from "../executionGatewayContracts";

export type PolicyOutcome =
  | "allow"
  | "deny"
  | "require_approval"
  | "require_simulation"
  | "require_policy_update"
  | "require_additional_context"
  | "deny_unless_compass_built";

export interface ReadOnlyRules {
  default: PolicyOutcome;
}

export interface TransfersRules {
  max_usd_without_approval: number;
  require_approval_for_unknown_recipient: boolean;
  blocked_recipients: string[];
}

export interface SwapsRules {
  max_usd_without_approval: number;
  max_slippage_bps: number;
  require_approval_for_unknown_token: boolean;
  allowed_protocols: string[];
}

export interface BridgesRules {
  default: PolicyOutcome;
  max_usd_per_day: number;
  allowed_chains: string[];
}

export interface SigningRules {
  sign_message: PolicyOutcome;
  sign_transaction: PolicyOutcome;
  sign_and_send_transaction: "deny_unless_compass_built" | PolicyOutcome;
}

export interface BlockedPatterns {
  unknown_program: PolicyOutcome;
  unlimited_delegate: PolicyOutcome;
  authority_change: PolicyOutcome;
  suspicious_recipient: PolicyOutcome;
}

export interface CompassPolicy {
  policy_id: string;
  version: string;
  default: PolicyOutcome;
  read_only: ReadOnlyRules;
  transfers: TransfersRules;
  swaps: SwapsRules;
  bridges: BridgesRules;
  signing: SigningRules;
  blocked: BlockedPatterns;
}

export interface PolicyEvaluationContext {
  amount_usd?: number;
  recipient_address?: string;
  recipient_known?: boolean;
  token_mint?: string;
  token_known?: boolean;
  protocol?: string;
  slippage_bps?: number;
  compass_built?: boolean;
  flags?: {
    unknown_program?: boolean;
    unlimited_delegate?: boolean;
    authority_change?: boolean;
    suspicious_recipient?: boolean;
  };
}

export interface PolicyEvaluation {
  decision: CompassDecision;
  policyId: string;
  reasonCodes: string[];
  evaluatedRules: string[];
}

export interface EvaluateActionInput {
  candidate: ActionCandidate;
  classification: ToolClassification;
  context: PolicyEvaluationContext;
  policy: CompassPolicy;
}
```

## Reason codes canónicos

| Code                                            | Significado                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `READ_ONLY_BY_POLICY`                           | Tool clasificada read-only y policy permite read-only.              |
| `TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT`         | Transfer ≤ max y recipient conocido.                                |
| `TRANSFER_EXCEEDS_LIMIT`                        | amount_usd > transfers.max_usd_without_approval.                    |
| `TRANSFER_UNKNOWN_RECIPIENT`                    | recipient_known=false con `require_approval_for_unknown_recipient`. |
| `TRANSFER_BLOCKED_RECIPIENT`                    | Recipient en `blocked_recipients`.                                  |
| `TRANSFER_MISSING_AMOUNT`                       | Acción sensible sin `amount_usd` (fail-closed).                     |
| `TRANSFER_INVALID_AMOUNT`                       | `amount_usd` no es finito o es negativo (fail-closed).              |
| `TRANSFER_MISSING_RECIPIENT`                    | Falta `recipient_address` o evidencia `recipient_known`.            |
| `SWAP_WITHIN_POLICY`                            | Swap dentro de límites, protocolo allowlisted y token conocido.     |
| `SWAP_SLIPPAGE_EXCEEDS_LIMIT`                   | slippage_bps > swaps.max_slippage_bps.                              |
| `SWAP_UNKNOWN_TOKEN`                            | token_known=false con `require_approval_for_unknown_token`.         |
| `SWAP_UNALLOWED_PROTOCOL`                       | protocol ∉ swaps.allowed_protocols.                                 |
| `SWAP_EXCEEDS_LIMIT`                            | amount_usd > swaps.max_usd_without_approval.                        |
| `SWAP_MISSING_CONTEXT`                          | Swap sin amount_usd, slippage_bps o protocol (fail-closed).         |
| `SWAP_INVALID_CONTEXT`                          | amount/slippage no son finitos o son negativos (fail-closed).       |
| `SIGN_MESSAGE_REQUIRES_APPROVAL`                | Default para `sign_message`.                                        |
| `SIGN_TRANSACTION_REQUIRES_SIMULATION`          | Default para `sign_transaction`.                                    |
| `DIRECT_SIGN_AND_SEND_BLOCKED`                  | `sign_and_send_transaction` sin `compass_built=true`.               |
| `SIGN_AND_SEND_COMPASS_BUILT_REQUIRES_APPROVAL` | `sign_and_send_transaction` Compass-built requiere aprobación.      |
| `BLOCKED_UNKNOWN_PROGRAM`                       | flags.unknown_program=true.                                         |
| `BLOCKED_UNLIMITED_DELEGATE`                    | flags.unlimited_delegate=true.                                      |
| `BLOCKED_AUTHORITY_CHANGE`                      | flags.authority_change=true.                                        |
| `BLOCKED_SUSPICIOUS_RECIPIENT`                  | flags.suspicious_recipient=true.                                    |
| `UNKNOWN_MUTATING_TOOL_DENIED`                  | Hereda Wave 1 sobre tool desconocida mutante.                       |
| `UNKNOWN_TOOL_NEEDS_CONTEXT`                    | Hereda Wave 1 sobre tool desconocida no mutante.                    |
| `POLICY_DEFAULT`                                | Fallback explícito a `policy.default`.                              |
| `CLASSIFICATION_DECISION_PRESERVED`             | Se preservó una decisión restrictiva de Wave 1.                     |

## Algoritmo de evaluación

`evaluateAction(input)` aplica reglas en orden de prioridad:

```
1. Signing-specific explicit rules (toolName):
   - sign_and_send_transaction + !compass_built → DENY (DIRECT_SIGN_AND_SEND_BLOCKED).
   - sign_and_send_transaction + compass_built → REQUIRE_HUMAN_APPROVAL.
   - sign_message → REQUIRE_HUMAN_APPROVAL.
   - sign_transaction → REQUIRE_SIMULATION.
2. Si classification.defaultDecision === DENY → mantener DENY (heredar/endurecer reasonCodes Wave 1).
3. Blocked patterns (context.flags):
   - unlimited_delegate / authority_change / suspicious_recipient → DENY.
   - unknown_program → REQUIRE_HUMAN_APPROVAL.
4. Si classification.riskClass === READ_ONLY → ALLOW + READ_ONLY_BY_POLICY.
5. Si classification.riskClass === BLOCKED_UNKNOWN → REQUIRE_ADDITIONAL_CONTEXT, sin importar actionKind.
6. Transfer (actionKind === "transfer"):
   - recipient_address ∈ blocked_recipients → DENY.
   - amount_usd undefined → REQUIRE_ADDITIONAL_CONTEXT (TRANSFER_MISSING_AMOUNT).
   - amount_usd no finito o negativo → REQUIRE_ADDITIONAL_CONTEXT (TRANSFER_INVALID_AMOUNT).
   - recipient_address o recipient_known faltante → REQUIRE_ADDITIONAL_CONTEXT (TRANSFER_MISSING_RECIPIENT).
   - amount_usd > max_usd_without_approval → REQUIRE_HUMAN_APPROVAL.
   - recipient_known === false + require_approval_for_unknown_recipient → REQUIRE_HUMAN_APPROVAL.
   - else → ALLOW.
7. Swap (actionKind === "swap"):
   - slippage_bps undefined OR protocol undefined OR amount_usd undefined → REQUIRE_ADDITIONAL_CONTEXT (SWAP_MISSING_CONTEXT).
   - amount_usd/slippage_bps no finitos o negativos → REQUIRE_ADDITIONAL_CONTEXT (SWAP_INVALID_CONTEXT).
   - slippage_bps > max_slippage_bps → REQUIRE_HUMAN_APPROVAL.
   - protocol ∉ allowed_protocols → REQUIRE_HUMAN_APPROVAL.
   - token_known === false + require_approval_for_unknown_token → REQUIRE_HUMAN_APPROVAL.
   - amount_usd > max_usd_without_approval → REQUIRE_HUMAN_APPROVAL.
   - else → ALLOW.
8. Fallback → mapear policy.default a CompassDecision.
```

Cada paso acumula `evaluatedRules` y `reasonCodes` antes de cortar.

## YAML por defecto

```yaml
policy_id: "default-conservative"
version: "0.1.0"
default: require_approval

read_only:
  default: allow

transfers:
  max_usd_without_approval: 10
  require_approval_for_unknown_recipient: true
  blocked_recipients:
    - known_bad_address

swaps:
  max_usd_without_approval: 25
  max_slippage_bps: 300
  require_approval_for_unknown_token: true
  allowed_protocols:
    - Jupiter
    - Raydium
    - Orca

bridges:
  default: require_approval
  max_usd_per_day: 100
  allowed_chains:
    - Solana
    - Base

signing:
  sign_message: require_approval
  sign_transaction: require_simulation
  sign_and_send_transaction: deny_unless_compass_built

blocked:
  unknown_program: require_approval
  unlimited_delegate: deny
  authority_change: deny
  suspicious_recipient: deny
```

## Dependencias

- **YAML parser:** `js-yaml` (light, ya popular en el ecosistema Node; revisar primero si Next ya lo trae transitivamente). Alternativa pura sin deps: parser ad-hoc minimal — descartado por mantenibilidad.
- Sin nuevas runtime deps salvo `js-yaml` + `@types/js-yaml`.

## TDD plan (orden RED → GREEN)

**Ronda 1 — Schema + Loader:**

1. RED: `loadDefaultPolicy()` devuelve `CompassPolicy` con `policy_id === "default-conservative"`.
2. RED: missing required field (ej. eliminar `transfers.max_usd_without_approval`) → error explícito.
3. RED: invalid PolicyOutcome value → error.
4. GREEN: implementar schema + loader.

**Ronda 2 — Engine:** 5. RED: read-only tool → ALLOW. 6. RED: transfer ≤ $10 + recipient conocido → ALLOW. 7. RED: transfer ≤ $10 + recipient desconocido → REQUIRE_HUMAN_APPROVAL. 8. RED: transfer > $10 → REQUIRE_HUMAN_APPROVAL. 9. RED: transfer a blocked_recipient → DENY. 10. RED: transfer sin amount_usd → REQUIRE_ADDITIONAL_CONTEXT. 11. RED: swap slippage > 300 → REQUIRE_HUMAN_APPROVAL. 12. RED: swap unknown token → REQUIRE_HUMAN_APPROVAL. 13. RED: swap protocolo no allowlisted → REQUIRE_HUMAN_APPROVAL. 14. RED: swap amount > $25 → REQUIRE_HUMAN_APPROVAL. 15. RED: swap sin slippage/protocol → REQUIRE_ADDITIONAL_CONTEXT. 16. RED: sign_and_send sin compass_built → DENY. 17. RED: sign_and_send con compass_built → REQUIRE_HUMAN_APPROVAL. 18. RED: blocked flags (delegate/authority/suspicious) → DENY. 19. RED: unknown_program flag → REQUIRE_HUMAN_APPROVAL. 20. RED: classification DENY (Wave 1) se preserva. 21. GREEN: implementar engine pasando los 16 outcome tests. 22. REFACTOR: extraer helpers comunes (matchTransferRules, matchSwapRules).

## Verificación final

- `npm run test:back` → tests verdes (Wave 1 + Wave 2).
- `npm run lint` → 0 errores en archivos Wave 2.
- `npx tsc --noEmit` → tipos coherentes.
- Sin cambios en comportamiento de la app: ningún archivo fuera de `back/services/policy/**` y `back/services/__tests__/policy*` se toca.
- Fresh reviewer revisa diff antes de merge a `release/compass_migration`.

## Riesgos y mitigaciones

| Riesgo                                                      | Mitigación                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Reglas se vuelven impossible-to-explain.                    | Reason codes enumerados arriba; cada regla agrega ≥1 reason.                                   |
| `js-yaml` introduce CVE o regresión.                        | Pinear versión exacta, revisar advisory; alternativa parser ad-hoc.                            |
| Engine afloja decisión DENY de Wave 1 por bug.              | Test explícito #20 asegura que `classification.defaultDecision === DENY` se preserva.          |
| Política se desincroniza del PRODUCT_CONSTITUTION §16.      | YAML cita la sección en comentario; cambio futuro requiere update doble.                       |
| Wave 3 (transfer) no encuentra el engine fácil de integrar. | Signature pura simple; aceptación final puede incluir un smoke "as-if integration" sin wiring. |
