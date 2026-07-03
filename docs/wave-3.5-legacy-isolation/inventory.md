# Inventory: Wave 3.5 — Legacy Isolation

Clasificación file-by-file del repo contra el norte Compass MCP Guard. Acompaña a [`proposal.md`](./proposal.md).

Clases:

- `new_guard` → queda en árbol principal, pertenece al MCP Guard.
- `shared_keep` → queda en árbol principal, lo usan ambos mundos.
- `legacy_strict` → se mueve a `legacy/<misma ruta>`.
- `repo_infra` → queda en árbol principal con ajustes específicos.
- `secret_or_unsafe` → sale del repo, va a `.gitignore`.
- `unknown` → necesita decisión humana.

## back/ (top-level)

| Archivo                    | Clase            | Notas                                                                                                                  |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `back/README.md`           | legacy_strict    | Lista los endpoints del chat-app (`/api/chat`, `/api/conditional-orders`, `/api/wallet/*`). En 3.5h se reemplaza por uno nuevo. |
| `back/.env.example`        | legacy_strict    | Hoy lista vars de DYNAMIC/BIRDEYE/RISK_SCORE/HELIUS/OPENAI/JUPITER. En 3.5h se crea uno mínimo en árbol principal con `AGENT_ACTION_GUARD_PROGRAM_ID`, `SOLANA_RPC_URL`, opcional `WALLET_SAFETY_ATTESTOR_SECRET_KEY`. |

## back/services/

### Núcleo Compass MCP Guard (new_guard)

| Archivo                                       | Por qué se queda                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `executionGateway.ts`                         | Wave 1 gateway: `classifyToolCall`, `createActionCandidate`, `buildAuditEvent`. Núcleo MCP Guard. |
| `executionGatewayContracts.ts`                | Tipos canonicales de decisiones, action candidate y audit. Núcleo.                              |
| `policy/policyEngine.ts`                      | Wave 2 policy engine.                                                                          |
| `policy/policyContracts.ts`                   | Tipos canonicales de policy.                                                                   |
| `policy/policySchema.ts`                      | Validación YAML.                                                                                |
| `policy/loadPolicy.ts`                        | Cargador de policy YAML.                                                                       |
| `policy/policyEvaluationResult.ts`            | Helper de outcomes/decisions.                                                                  |
| `policy/defaultPolicy.yaml`                   | Policy MVP conservadora.                                                                       |
| `transferGateway.ts`                          | Wave 3 transfer guard, behavior.                                                                |
| `transferGatewayContracts.ts`                 | Wave 3 contracts.                                                                              |
| `transferAuditLog.ts`                         | Wave 3 sink in-memory de audit.                                                                 |
| `onchainApproval.ts`                          | Verificación contra `agent-action-guard` program. Forma parte del signer/approval boundary.    |

### Compartido entre ambos (shared_keep)

| Archivo                       | Por qué se queda                                                                                    | Notas                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `walletSafetyValidation.ts`   | Risk/destination evidence. El guard lo necesita y el chat también lo usaba.                          | Auditar `assessTransferRisk`/canonical helpers que solo usa `tools/transfer` (legacy). |
| `solanaConnection.ts`         | Conexión RPC centralizada. La usan guard y legacy.                                                  |                                                                                        |
| `solanaNetworkConfig.ts`      | Constantes de red y mints. Compartido.                                                              |                                                                                        |
| `priceQuote.ts`               | Da `amount_usd` al transfer guard. Hoy importa `tools/orcaSwap`.                                    | Wave 3.5e: extraer el helper de quote a `priceProviders/orcaUsdcSol.ts`.                |
| `upstream.ts`                 | `getEnv`, `jsonResponse`, `passthrough`. Lo usan guard y muchos provider routes viejos.            | Wave 3.5f: rename a `envHttp.ts`; legacy se lleva su propia copia.                     |

### Legacy estrictamente del producto viejo (legacy_strict)

| Archivo                              | Por qué es legacy                                                                                                | Tests acoplados                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `chat.ts`                            | Entrypoint del producto viejo (`/api/chat`, SSE, proposals, tool routing). MCP Guard no debería tener un “chat”. | `__tests__/chat.test.ts`                     |
| `chatSessionStore.ts`                | Estado de sesión del chat. No aplica al MCP Guard.                                                              | `__tests__/chatSessionStore.test.ts`         |
| `azureResponsesClient.ts`            | Client del LLM-as-chat. El MCP Guard puede usar LLM, pero no este cliente atado al producto viejo.              | `__tests__/azureResponsesClient.test.ts`     |
| `guardrailExplanations.ts`           | Construye textos de explicación para la UI del chat.                                                            | `__tests__/guardrailExplanations.test.ts`    |
| `guardrailNarration.ts`              | Narración con LLM para UI del chat.                                                                              | `__tests__/guardrailNarration.test.ts`       |
| `walletHoldings.ts`                  | Endpoint `/api/wallet/balances` para la UI vieja.                                                                | `__tests__/walletHoldings.test.ts`           |
| `transactionHistory.ts`              | Endpoint `/api/wallet/transactions` para la UI vieja.                                                            | n/a                                          |
| `conditionalOrders.ts`               | Endpoint `/api/conditional-orders` para la UI vieja.                                                            | n/a                                          |
| `jupiter.ts`                         | Proxy de Jupiter para la UI vieja.                                                                              | n/a                                          |
| `birdeye.ts`                         | Proxy de Birdeye para la UI vieja.                                                                              | n/a                                          |
| `helius.ts`                          | Proxy de Helius para la UI vieja.                                                                                | n/a                                          |
| `riskScore.ts`                       | Endpoint `/api/risk-score` para la UI vieja.                                                                    | n/a                                          |
| `auth/appSession.ts`                 | Sesión web del producto viejo (Dynamic).                                                                         | `__tests__/appSession.test.ts`               |
| `auth/dynamic.ts`                    | Verificación de Dynamic auth.                                                                                    | `__tests__/dynamicAuth.test.ts`              |
| `tools/transfer.ts`                  | Tool LLM del chat. El transfer guard nuevo no la usa.                                                            | acoplado a `chat.test.ts` via prepareTransferResult |
| `tools/conditionalBuySol.ts`         | Tool LLM del chat para conditional buy.                                                                          | `__tests__/conditionalBuySol.test.ts`        |
| `tools/orcaSwapTx.ts`                | Construcción de swap-tx para la UI.                                                                              | n/a                                          |
| `tools/swapGuard.ts`                 | Swap guard del producto viejo (vivía como tool del chat). Existe nuevo gateway/policy; este es legacy.          | n/a                                          |
| `tools/swapGuardOnChain.ts`          | Helpers on-chain para swap guard viejo.                                                                          | n/a                                          |
| `tools/orcaSwap.ts`                  | Quote y otros helpers de swap. **Se mueve a legacy después de Wave 3.5e** (extracción del quote a priceProviders). | `__tests__/orcaSwap.test.ts`                 |

## back/services/__tests__/

| Archivo                                   | Clase            | Razón                                                              |
| ----------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `executionGateway.test.ts`                | new_guard        | Cubre Wave 1.                                                      |
| `policyEngine.test.ts`                    | new_guard        | Cubre Wave 2.                                                       |
| `loadPolicy.test.ts`                      | new_guard        | Cubre Wave 2.                                                       |
| `transferGateway.test.ts`                 | new_guard        | Cubre Wave 3.                                                       |
| `walletSafetyValidation.test.ts`          | shared_keep      | Risk primitives.                                                    |
| `onchainApproval.test.ts`                 | new_guard        | Verifica integración con program.                                   |
| `priceQuote.test.ts`                      | shared_keep      | Tras Wave 3.5e, sigue compartido.                                  |
| `chat.test.ts`                            | legacy_strict    | Cubre el chat viejo. Va con `chat.ts`.                              |
| `chatSessionStore.test.ts`                | legacy_strict    | Acompaña a `chatSessionStore.ts`.                                   |
| `azureResponsesClient.test.ts`            | legacy_strict    |                                                                     |
| `guardrailExplanations.test.ts`           | legacy_strict    |                                                                     |
| `guardrailNarration.test.ts`              | legacy_strict    |                                                                     |
| `walletHoldings.test.ts`                  | legacy_strict    |                                                                     |
| `conditionalBuySol.test.ts`               | legacy_strict    |                                                                     |
| `orcaSwap.test.ts`                        | legacy_strict    | Tras Wave 3.5e.                                                     |
| `appSession.test.ts`                      | legacy_strict    |                                                                     |
| `dynamicAuth.test.ts`                     | legacy_strict    |                                                                     |

## back/solana/

| Carpeta                  | Clase     | Razón                                                                |
| ------------------------ | --------- | -------------------------------------------------------------------- |
| `agent-action-guard/`    | new_guard | Programa Anchor del guard, base del signer/approval boundary.        |
| `conditional-escrow-buy/`| new_guard | Programa Anchor para semi-autonomous conditional execution.          |

## back/sdd/

| Carpeta             | Clase         | Razón                                                                                                                  |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `back/sdd/wip/001-chat` y similares | legacy_strict | Specs del producto viejo. Mover entero a `legacy/sdd/back-sdd/`.                                                       |

## app/

| Ruta                                    | Clase           | Razón                                                                                                  |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `app/route.ts`                          | shared_keep     | Sirve `landing.html` en `/`. La landing **no** es legacy.                                              |
| `app/landing/route.ts`                  | shared_keep     | Redirect `/landing` → `/`. Forma parte de la landing.                                                  |
| `app/layout.tsx`                        | repo_infra      | Se conserva pero se simplifica: deja de importar `front/src/styles/globals.css`.                       |
| `app/not-found.tsx`                     | repo_infra      | Se conserva minimalista para el 404 público.                                                            |
| `app/home/`                             | legacy_strict   | Página principal del chat-app React.                                                                    |
| `app/dynamic-reset/`                    | legacy_strict   | Página de reset de Dynamic.                                                                             |
| `app/api/chat/`                         | legacy_strict   | Entrypoint del chat-app.                                                                                |
| `app/api/auth/**`                       | legacy_strict   | Dynamic auth del producto viejo.                                                                        |
| `app/api/config/dynamic/`               | legacy_strict   | Config de Dynamic.                                                                                      |
| `app/api/wallet/**`                     | legacy_strict   | Balances/transactions/allocation para UI vieja.                                                         |
| `app/api/conditional-orders/**`         | legacy_strict   | UI vieja.                                                                                                |
| `app/api/birdeye/**`                    | legacy_strict   | Proxy para UI vieja.                                                                                     |
| `app/api/helius/**`                     | legacy_strict   | Proxy para UI vieja.                                                                                     |
| `app/api/jupiter/**`                    | legacy_strict   | Proxy para UI vieja.                                                                                     |
| `app/api/network/status/`               | legacy_strict   | Status para UI vieja.                                                                                    |
| `app/api/prices/`                       | legacy_strict   | Prices para UI vieja.                                                                                    |
| `app/api/quotes/usdc-sol/`              | legacy_strict   | Hoy sólo lo usa la UI vieja; el guard usa `priceQuote` directamente.                                    |
| `app/api/risk-score/`                   | legacy_strict   | UI vieja.                                                                                                |

Tras la wave, `app/` solo contiene la landing pública (`app/route.ts`, `app/landing/route.ts`, `app/layout.tsx` simplificado, `app/not-found.tsx`) hasta que se agreguen entrypoints del MCP Guard. `npm run build` sigue verde.

## Landing pública (queda en árbol principal)

La landing es la cara pública de Compass y debe seguir respondiendo en `/`. Todo `public/` se considera bucket de la landing/branding y queda fuera de `legacy/`, con una sola excepción verificada (`architecture-explainer.html`).

Evidencia (`rg` sobre el repo completo, excluyendo `node_modules`, `.next`, `public/`):

| Asset                                | Usado por                                                                                  | Clase         |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------- |
| `landing.html`                       | `app/route.ts` (lo lee y lo sirve en `/`).                                                 | shared_keep   |
| `compass-icon.png`                   | `landing.html` (favicon + apple-touch + brand-mark) y `app/layout.tsx` (metadata).         | shared_keep   |
| `compass-icon-32.png`                | `landing.html` (favicon) y `app/layout.tsx` (metadata).                                    | shared_keep   |
| `needle-mascot.png`                  | `landing.html` (img del hero secundario).                                                  | shared_keep   |
| `needle-mascot-welcome.png`          | `landing.html` (img del hero principal).                                                   | shared_keep   |
| `compass-logo-mark.png`              | `scripts/build-favicon.mjs` (input para generar los iconos).                               | shared_keep   |
| `compass-logo.png`, `compass-logo.svg` | Sin referencias tracked. Branding de la landing/README para uso futuro.                  | shared_keep   |
| `compass-banner.png`, `compass-banner.svg` | Sin referencias tracked. Branding de la landing/README para uso futuro.              | shared_keep   |
| `compass-banner-light.svg`           | Sin referencias tracked. Asset agregado recientemente para la landing.                     | shared_keep   |
| `compass-banner-needle.png`          | Sin referencias tracked. Asset agregado recientemente para la landing.                     | shared_keep   |
| `needle-hello.png`, `needle-point.png`, `needle-think.png`, `needle-welcome.png` | Sin referencias tracked en código activo. Branding del personaje Needle para la landing. | shared_keep   |
| `architecture-explainer.html`        | Sin referencias en código. Su `<title>` dice “Wallet Copilot · Arquitectura actual” (marca anterior).   | legacy_strict |

Ajustes asociados durante Wave 3.5c:

- `app/layout.tsx`: quitar `import '../front/src/styles/globals.css';` (la landing es HTML con CSS inline; no necesita Tailwind del front).
- `landing.html`: las CTAs que hoy apuntan a `/home` quedan apuntando a una ruta inexistente. Reescribir el `href="/home"` a `href="#flow"` para que el botón siga viviendo pero apunte a una sección existente de la landing hasta que esté el entrypoint MCP Guard. Dejar un comment `<!-- TODO: re-point CTA to MCP Guard entrypoint once it exists -->` en cada ocurrencia.

## front/

Todo el árbol `front/src/**` se mueve a `legacy/front/`.

Incluye:

- `components/chat/**`, `components/sidebar/**`, `components/wallet/**`, `components/layout/**`, `components/status/**`, `components/ui/**` (shadcn library).
- `hooks/**`.
- `stores/**`.
- `lib/**`.
- `providers/**`.
- `styles/**`, `types/**`.

Razón: ninguno de estos archivos es parte del Compass MCP Guard. La UI nueva (si existe) será de approval/inspection y se construirá fresh.

## Otros archivos raíz

| Archivo / Carpeta             | Clase             | Razón                                                                                                                                |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `landing.html`                | shared_keep       | Landing pública nueva-product-ready; queda fuera de `legacy/`.                                                                       |
| `public/**`                   | shared_keep       | Bucket de la landing/branding; queda entero en árbol principal. Única excepción: `architecture-explainer.html` (Wallet Copilot, legacy). |
| `scripts/test-chat.ts`        | legacy_strict     | Smoke test del chat viejo.                                                                                                            |
| `scripts/test-real-onchain-transfer.ts` | legacy_strict | Test ad-hoc viejo.                                                                                                                  |
| `scripts/bootstrap-conditional-devnet.mjs` | legacy_strict | Bootstrap específico de devnet conditional, atado al producto viejo. Eventualmente se reescribe para MCP Guard demos.            |
| `scripts/build-favicon.mjs`   | shared_keep       | Genera `compass-icon.png`/`compass-icon-32.png` para la landing actual. Queda en árbol principal.                                    |
| `verify-implementation.sh`    | legacy_strict     | Script ad-hoc.                                                                                                                        |
| `progress.md`                 | legacy_strict     | Notas viejas.                                                                                                                          |
| `learning-explanations/`      | legacy_strict     | Notas de investigación del producto viejo.                                                                                            |
| `openspec/`                   | legacy_strict     | AGENTS pide una sola fuente SDD en `docs/`. Mover a `legacy/sdd/openspec/`.                                                          |
| `sdd/wip/`                    | legacy_strict     | Specs viejos en progreso. Mover a `legacy/sdd/wip/`.                                                                                  |
| `sdd/done/`                   | legacy_strict     | Specs viejos cerrados (`003-approve-swap-oracle-guard-execution`, `004-swap-guard-warning-bypass`). Mover a `legacy/sdd/done/`.       |
| `next-env.d.ts`               | repo_infra        | Auto-generado por Next; se conserva si seguimos con Next, o se elimina si dropeamos Next.                                            |
| `next.config.mjs`             | repo_infra        | Ajustar para no compilar `legacy/`.                                                                                                   |
| `tailwind.config.js`          | legacy_strict     | Solo usado por front legacy. Mover. Si la landing decide adoptar Tailwind a futuro, reintroducir una config nueva en el árbol principal. |
| `postcss.config.mjs`          | legacy_strict     | Idem.                                                                                                                                  |
| `eslint.config.js`            | repo_infra        | Ajustar para agregar `no-restricted-imports` contra `legacy/`.                                                                        |
| `tsconfig.json`               | repo_infra        | Excluir `legacy/`.                                                                                                                    |
| `tsconfig.tsbuildinfo`        | repo_infra        | Build cache, no requiere acción.                                                                                                       |
| `vitest.config.ts`            | repo_infra        | Excluir `legacy/`.                                                                                                                    |
| `vitest.back.config.ts`       | repo_infra        | Excluir `legacy/`.                                                                                                                    |
| `package.json`                | repo_infra        | Ajustar scripts; dependencias quedan (limpieza diferida).                                                                              |
| `README.md`                   | repo_infra        | Reescribir hacia MCP Guard.                                                                                                            |
| `AGENTS.md`                   | repo_infra        | Reescribir/actualizar reglas de migración para reflejar `legacy/`.                                                                    |

## docs/

### Queda en árbol principal

- `docs/PRODUCT_CONSTITUTION.md` (norte).
- `docs/compass-monad-on-solana/` (migration plan).
- `docs/wave-2-policy-engine/` (spec activa).
- `docs/wave-3-transfer-behind-gateway/` (spec activa).
- `docs/wave-3.5-legacy-isolation/` (esta propuesta).
- `docs/README.md` (índice, reescribir para reflejar producto nuevo).
- `docs/development-workflow.md` y `docs/onchain-deployments.md` se revisan caso por caso; si son del producto viejo, se mueven.

### Va a `legacy/docs/`

- `docs/api-reference.md` (describe `/api/chat`).
- `docs/architecture-design.md` (arquitectura del producto viejo).
- `docs/compass_artifact_*.md` (investigación vieja).
- `docs/simulated-swap-safety-guard.md`.
- `docs/swap-guard-explainer.html`.
- `docs/token-risk-guard-backend.md`.
- `docs/phantom-external-transaction-contracts.md`.
- Folders por feature del producto viejo:
  - `agent-action-guard-guarded-transfer/`
  - `agent-quotes-and-holdings/`
  - `ai-sdk-agent-migration/`
  - `backend-chat-session-history/`
  - `chat-session-history/`
  - `contextual-guardrail-explanations/`
  - `conditional-order-db-keeper/`
  - `devnet-conditional-escrow-buy-sol/`
  - `dynamic-wallet-auth/`
  - `phantom-direct-connection/`
  - `transaction-history/`
  - `transaction-logic/`
  - `wallet-balance-display/`
  - `wallet-linked-chat-history/`
  - `wallet-safety-validation/`
  - `wallet-safety-validation-onchain-enforcement/`

## Secretos / no-repo

| Archivo               | Clase             | Acción                                                                                            |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `credentials`         | secret_or_unsafe  | Confirmar contenido (sin leerlo desde acá), rotar si hace falta, `git rm --cached`, `.gitignore`. |
| `dynamic_private_key` | secret_or_unsafe  | Idem.                                                                                              |

## Dependencias cruzadas a resolver

1. `back/services/priceQuote.ts` → `back/services/tools/orcaSwap.ts`. Resolver en Wave 3.5e con `priceProviders/orcaUsdcSol.ts`.
2. `back/services/guardrailExplanations.ts` (legacy) → `back/services/tools/transfer.ts` (legacy) + `back/services/tools/swapGuard.ts` (legacy). No bloquea aislación: ambos van juntos a `legacy/`.
3. `back/services/walletHoldings.ts` (legacy) → `back/services/transactionHistory.ts` (legacy). Idem.
4. `back/services/chat.ts` (legacy) → `transferGateway.ts` (new_guard) y `walletSafetyValidation.ts` (shared_keep) y `onchainApproval.ts` (new_guard) y `priceQuote.ts` (shared_keep) y `solanaConnection.ts` (shared_keep). Dirección OK: legacy importa de new/shared, no al revés.
5. `back/services/tools/transfer.ts` (legacy) → `walletSafetyValidation.ts` (shared_keep). OK.
6. `back/services/__tests__/policyEngine.test.ts` y otros tests de new_guard: revisar que no importen helpers legacy. Spot-check: importan solo `../executionGateway*`, `./policy/*`.

## Top 5 riesgos operativos

1. **`npm run build` rompe** al mover `app/`. Mitigación: placeholder en `app/page.tsx` y actualizar `next.config.mjs`.
2. **TypeScript path aliases** (`@/*`, `@front/*`) apuntan a `front/src/`. Si front se mueve, esos paths quedan colgando para el árbol principal. Mitigación: el árbol principal no debería usar esos paths; restringirlos a `legacy/`.
3. **Vitest sigue capturando `legacy/**`**. Sin exclude explícito, los tests rotos del legacy frenan el CI. Mitigación: setear `exclude` en ambas vitest configs.
4. **ESLint pasa sobre legacy**. Sin exclusión, puede romper. Mitigación: el script `lint` ya apunta a `app front/src back/services`; eliminar `front/src` y añadir guardas no-restricted-imports.
5. **Imports cruzados ocultos**. Algún `legacy/back/...` puede terminar siendo importado por error. Mitigación: regla ESLint `no-restricted-imports` con patrón `legacy/**` desde `app/**` y `back/**` no-legacy.

## Sequencing recomendado

`3.5a (plumbing)` → `3.5g (secretos)` → `3.5b (docs)` → `3.5e (priceQuote refactor)` → `3.5f (envHttp rename)` → `3.5d (back/services)` → `3.5c (front+app)` → `3.5h (docs finales)`.

Orden alternativo más conservador: `3.5a → 3.5g → 3.5b → 3.5c → 3.5e → 3.5f → 3.5d → 3.5h`. Cualquiera sirve mientras cada paso quede verde.
