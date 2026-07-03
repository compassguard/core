# Functional Spec: Wave 2 — Policy Engine v0

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-06-05
- **Estado:** Draft para revisión
- **Feature:** `wave-2-policy-engine`
- **Wave:** 2 (de la migración Compass MCP Guard v0)
- **Branch:** `feature/wave-2-policy-engine`
- **Base:** `release/compass_migration`

## Resumen

Construir el **policy engine v0** del execution firewall: capa pura, determinística y explicable que combina los contratos de Wave 1 (`ToolClassification`, `ActionCandidate`) con contexto de ejecución (monto, recipient, slippage, token, protocolo) y una política YAML versionada para producir una `CompassDecision` con reason codes auditables.

El engine se mantiene **unwired** en esta wave: no se conecta todavía a `back/services/chat.ts` ni a flujos de transfer/swap. Wave 3 será la primera integración (transfer).

## Objetivo

Permitir que cualquier acción agentica sobre Solana pase por una capa de decisión deterministica antes de signing/execution:

- La política vive en YAML versionado en el repo, fácil de revisar y editar.
- Los defaults son **conservadores** según `docs/PRODUCT_CONSTITUTION.md §16`.
- Las decisiones son **fail-closed**: si falta evidencia para una acción sensible, no se permite.
- Cada decisión expone **reason codes** y la lista de **reglas evaluadas**.

## Principios funcionales

| Tema           | Decisión                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Almacenamiento | YAML local versionado en `back/services/policy/defaultPolicy.yaml`.                                |
| Versioning     | Cada política tiene `policy_id` legible (ej. `default-conservative`).                              |
| Pureza         | `evaluateAction()` es función pura: mismos inputs → misma decisión.                                |
| Composición    | El engine recibe la `ToolClassification` de Wave 1 y solo la **endurece**, nunca la afloja.        |
| Fail-closed    | Falta de evidencia para acción mutante o sensible → `REQUIRE_ADDITIONAL_CONTEXT` o `DENY`.         |
| Reason codes   | Cada `decision` viene con `reasonCodes[]` y `evaluatedRules[]` para auditoría y UI explainability. |
| Wire-up        | No se cablea a `chat.ts` ni a tools en esta wave. Solo contratos + tests.                          |

## Alcance

### Incluido

- Schema TypeScript para la `CompassPolicy` cubriendo: `default`, `read_only`, `transfers`, `swaps`, `bridges`, `signing`, `blocked`.
- `defaultPolicy.yaml` con los valores conservadores del PRODUCT_CONSTITUTION §16.
- Loader/parser de YAML con validación de schema y errores explicables.
- `evaluateAction(input)` que combina classification + context + policy → `PolicyEvaluation`.
- Reglas implementadas para read-only, transfers, swaps, signing y blocked patterns.
- Tests TDD por outcome (allow / approval / deny / fail-closed).
- Reason codes estables y documentables.

### Fuera de alcance

- Conectar el engine a `back/services/chat.ts` o a tools concretas (eso es Wave 3).
- Cambiar el flujo de aprobación UI / signer boundary (Wave 6).
- Almacenamiento en DB o on-chain de políticas (futuro, no MVP).
- Multi-tenant policies o policies por usuario (futuro).
- Risk scoring numérico (Wave 5+ y posterior; Wave 4 se enfoca en MCP server/tool boundary).
- Bridges: contemplados en el schema, pero solo con default conservador, sin reglas finas (no es MVP demo).

## Casos de decisión

### Read-only

| Caso                                      | Decisión esperada |
| ----------------------------------------- | ----------------- |
| `get_wallet_holdings`, cualquier contexto | `ALLOW`           |
| `get_usdc_sol_quote`, cualquier contexto  | `ALLOW`           |

### Transfers

| Caso                                                      | Decisión esperada                          |
| --------------------------------------------------------- | ------------------------------------------ |
| `transfer_sol`, amount ≤ $10 USD, recipient conocido      | `ALLOW`                                    |
| `transfer_sol`, amount ≤ $10 USD, recipient desconocido   | `REQUIRE_HUMAN_APPROVAL`                   |
| `transfer_sol`, amount > $10 USD, recipient conocido o no | `REQUIRE_HUMAN_APPROVAL`                   |
| `transfer_sol`, recipient en `blocked_recipients`         | `DENY`                                     |
| `transfer_sol` sin `amount_usd` en contexto               | `REQUIRE_ADDITIONAL_CONTEXT` (fail-closed) |

### Swaps

| Caso                                                                                              | Decisión esperada            |
| ------------------------------------------------------------------------------------------------- | ---------------------------- |
| `orca_swap`/`quote_swap`, amount ≤ $25, slippage ≤ 300 bps, token conocido, protocolo allowlisted | `ALLOW`                      |
| `orca_swap`, slippage > 300 bps                                                                   | `REQUIRE_HUMAN_APPROVAL`     |
| `orca_swap`, token desconocido                                                                    | `REQUIRE_HUMAN_APPROVAL`     |
| `orca_swap`, protocolo no allowlisted                                                             | `REQUIRE_HUMAN_APPROVAL`     |
| `orca_swap`, amount > $25                                                                         | `REQUIRE_HUMAN_APPROVAL`     |
| `orca_swap` sin slippage/protocol/amount en contexto                                              | `REQUIRE_ADDITIONAL_CONTEXT` |

### Signing

| Caso                                                              | Decisión esperada                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `sign_message`                                                    | `REQUIRE_HUMAN_APPROVAL`                               |
| `sign_transaction`                                                | `REQUIRE_SIMULATION`                                   |
| `sign_and_send_transaction` sin `compass_built: true` en contexto | `DENY` (con reason `DIRECT_SIGN_AND_SEND_BLOCKED`)     |
| `sign_and_send_transaction` con `compass_built: true`             | `REQUIRE_HUMAN_APPROVAL` (puede seguir su path normal) |

### Blocked patterns

| Caso                                          | Decisión esperada        |
| --------------------------------------------- | ------------------------ |
| Tool flag `unknown_program: true` en contexto | `REQUIRE_HUMAN_APPROVAL` |
| Tool flag `unlimited_delegate: true`          | `DENY`                   |
| Tool flag `authority_change: true`            | `DENY`                   |
| Tool flag `suspicious_recipient: true`        | `DENY`                   |

### Unknown / fallback

| Caso                                                                   | Decisión esperada            |
| ---------------------------------------------------------------------- | ---------------------------- |
| Tool desconocida no mutante (clasificada `BLOCKED_UNKNOWN` por Wave 1) | `REQUIRE_ADDITIONAL_CONTEXT` |
| Tool desconocida mutante                                               | `DENY`                       |

## Garantías de seguridad

1. **Las decisiones del engine nunca afloja la decisión por defecto de la classification de Wave 1.** Si Wave 1 dijo `DENY` (signing directo), el engine no puede devolver `ALLOW` sin evidencia explícita.
2. **El engine es una función pura.** No hace IO, no llama RPC, no toca disco más allá del loader que se ejecuta una vez al inicio.
3. **Todas las decisiones tienen `reasonCodes` y `evaluatedRules` no vacíos** (excepto `ALLOW` por `read-only`, que igual lleva reason `READ_ONLY_BY_POLICY`).
4. **Falta de contexto sensible** (amount_usd, slippage_bps, protocol, recipient_known) en acciones mutantes → fail-closed.

## Acceptance criteria global

- `defaultPolicy.yaml` parsea sin error y matchea el schema TS.
- `evaluateAction()` cubre los 18+ casos listados arriba con tests RED→GREEN.
- Reason codes son estables y están listados en el technical-spec.
- Sin cambios en comportamiento existente de la app (engine unwired).
- `npm run test:back` y `npm run lint` pasan limpios en `feature/wave-2-policy-engine`.
- No se introduce dependencia nueva fuera del YAML parser estándar que ya existe en el ecosistema Node/Next.
