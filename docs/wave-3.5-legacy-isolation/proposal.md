# Proposal: Wave 3.5 — Legacy Isolation

## Estado

- **Versión:** 0.1
- **Fecha:** 2026-06-06
- **Tipo:** Propuesta para aprobar antes de ejecutar
- **Base de rama propuesta:** `release/compass_migration`
- **Rama propuesta:** `feature/wave-3.5-legacy-isolation`

## Motivación

El repo todavía está dominado por el **producto anterior**: una app Next.js con chat hacia el usuario, Dynamic wallet onboarding, sidebar/home, proposals card, tool-call orchestration, y endpoints de soporte (Jupiter/Birdeye/Helius/Risk-Score/Quotes/Auth).

El nuevo producto, según `docs/PRODUCT_CONSTITUTION.md` y `docs/compass-monad-on-solana/mvp-migration-plan.md`, es **Compass MCP Guard**, un execution firewall para agentes de IA. El norte explícito dice que Compass **no es un chatbot DeFi**. El LLM, cuando se use, debe ser parte de la capa de seguridad (intent mismatch, prompt injection, explicación de riesgo), no de un chat hacia el front.

Wave 3 quedó implementada cableando gateway/policy/audit dentro de `back/services/chat.ts` para no romper la UX actual. Eso funciona técnicamente, pero acopla la capa de seguridad al producto viejo y bloquea la migración.

Esta propuesta **no borra nada**. Aísla todo el código del producto anterior en una carpeta `legacy/` totalmente desconectada y deja el árbol principal solo con piezas del Compass MCP Guard. Sirve como referencia y como red de seguridad: si necesitamos volver a mirar cómo se hacía algo, está ahí, pero no contamina nada nuevo.

## Principios

1. **`legacy/` queda totalmente aislado.** Ningún archivo fuera de `legacy/` puede importar nada de `legacy/`. Esto se enforza con tooling (ESLint `no-restricted-imports`, exclude en `tsconfig.json` y `vitest.*.config.ts`).
2. **`legacy/` no se borra.** Sigue ahí como referencia. Se puede ejecutar opcionalmente con un runner aparte si se quisiera, pero no es parte del producto.
3. **El árbol principal contiene únicamente piezas del Compass MCP Guard**: execution gateway, policy engine, transfer guard, wallet safety, on-chain approval, programs Anchor, contracts y tests.
4. **No se introducen entrypoints nuevos del MCP Guard en esta wave.** Esta wave solo aísla. La construcción del nuevo boundary (MCP server, tool boundary, signer adapter) la hace una wave posterior (4+ según el migration plan).
5. **Secretos no van a `legacy/`.** Salen del repo y al `.gitignore`.
6. **La landing sí se queda en el árbol principal.** `landing.html` y sus assets son la cara pública de Compass; viven fuera de `legacy/` y se sirven en `/`. Lo que se va a `legacy/` es la app React vieja (`/home`, hooks/stores/components del chat), no la landing.

## Convenciones de clasificación

Cada archivo/folder se clasifica como:

- `new_guard`: pertenece al Compass MCP Guard nuevo, queda en el árbol principal.
- `shared_keep`: usado por ambos mundos, queda en el árbol principal con justificación.
- `legacy_strict`: pertenece solo al producto viejo, se mueve a `legacy/`.
- `repo_infra`: configs/docs transversales, queda en el árbol principal con ajustes.
- `secret_or_unsafe`: no debe estar en el repo, sale.
- `unknown`: necesita decisión humana antes de moverse.

El inventario detallado vive en [`inventory.md`](./inventory.md).

## Layout objetivo

Tras esta wave, el repo se ve así (resumen):

```txt
.
├── AGENTS.md
├── README.md
├── app/                       # solo entrypoints nuevos del MCP Guard (placeholder por ahora)
├── back/
│   ├── services/
│   │   ├── executionGateway.ts
│   │   ├── executionGatewayContracts.ts
│   │   ├── policy/...
│   │   ├── transferGateway.ts
│   │   ├── transferGatewayContracts.ts
│   │   ├── transferAuditLog.ts
│   │   ├── walletSafetyValidation.ts
│   │   ├── onchainApproval.ts
│   │   ├── priceQuote.ts                       # depende de priceProviders/, ya no de tools/
│   │   ├── priceProviders/orcaUsdcSol.ts       # extracción mínima, sin tocar legacy
│   │   ├── solanaConnection.ts
│   │   ├── solanaNetworkConfig.ts
│   │   ├── envHttp.ts                          # rename de upstream.ts (helpers neutros)
│   │   └── __tests__/...                       # solo los nuevos y los compartidos
│   └── solana/
│       ├── agent-action-guard/...
│       └── conditional-escrow-buy/...
├── docs/
│   ├── PRODUCT_CONSTITUTION.md
│   ├── compass-monad-on-solana/...
│   ├── wave-2-policy-engine/...
│   ├── wave-3-transfer-behind-gateway/...
│   └── wave-3.5-legacy-isolation/...
├── landing.html                # landing pública, queda fuera de legacy/
├── public/                     # assets de landing + branding compartido
├── legacy/
│   ├── README.md
│   ├── app/                  # app/home, app/dynamic-reset, app/api/** del chat-app
│   ├── back/                 # chat.ts, providers viejos, tools del chat, README, .env.example viejo
│   ├── front/                # toda la UI vieja (src + docs + README)
│   ├── docs/                 # specs de features del producto viejo
│   ├── sdd/                  # back/sdd/, sdd/wip, sdd/done, openspec/ consolidados
│   ├── public/               # solo architecture-explainer.html (marca “Wallet Copilot”)
│   ├── scripts/              # bootstrap-conditional-devnet.mjs, test-chat.ts, etc.
│   └── learning-explanations/
├── package.json
├── tsconfig.json             # excluye legacy/
├── vitest.config.ts          # excluye legacy/
├── vitest.back.config.ts     # excluye legacy/
└── eslint.config.js          # no-restricted-imports prohibe legacy/* fuera de legacy/
```

## Sub-waves propuestas

La isolación se rompe si se hace en un solo PR gigante. Propongo dividirla en sub-waves que dejen el árbol verde tras cada paso:

### Wave 3.5a — Plumbing y guardrails (sin mover archivos)

- Crear `legacy/README.md` con definición, reglas y comandos opcionales para correr el legacy aparte.
- Crear `docs/wave-3.5-legacy-isolation/` (esta proposal + inventario + review-notes).
- `.gitignore`: `credentials` y `dynamic_private_key` **ya están**. Tampoco hay tracking activo (verificado con `git ls-files`). 3.5a no toca `.gitignore` por estos archivos.
- ESLint (`eslint.config.js`, flat config): agregar `legacy/**` al `ignores` global y un bloque con `no-restricted-imports` que prohíba importar `legacy/` desde fuera. Shape de referencia:

  ```js
  {
    files: ['**/*.{ts,tsx,js,mjs,jsx}'],
    ignores: ['legacy/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/legacy/**', 'legacy/**', './legacy/**', '../**/legacy/**'],
            message: 'Compass MCP Guard code must not import from legacy/.' }
        ]
      }]
    }
  }
  ```

- `tsconfig.json`: agregar `"legacy/**"` al `exclude` existente (`node_modules`, `front/node_modules`, `front/src/main.tsx`). Opcional: `legacy/tsconfig.json` propio si queremos type-check de legacy aparte.
- `vitest.config.ts` y `vitest.back.config.ts`: agregar `test.exclude: ['legacy/**', 'node_modules/**']`.
- `package.json`: agregar `lint:legacy` y `test:legacy` opcionales para correr legacy aparte; `lint` y `test:back` actuales siguen funcionando.

Validación: `npm run test:back`, `npm run lint`, `npx tsc --noEmit` siguen verdes.

### Wave 3.5b — Mover docs/SDD legacy

Mover a `legacy/docs/` y `legacy/sdd/`:

- Docs de features del producto viejo (lista completa en `inventory.md`).
- `back/sdd/wip/*`, `sdd/wip/*`, `sdd/done/*`.
- `openspec/` (queda solo el `config.yaml`, que ya quedó duplicado contra `docs/`).
- `learning-explanations/`, `progress.md`, `compass_artifact_*.md`, `simulated-swap-safety-guard.md`, `swap-guard-explainer.html`, `token-risk-guard-backend.md`, `phantom-external-transaction-contracts.md`, `architecture-design.md`, `api-reference.md` (este último describe `/api/chat`).

Validación: docs-only, no rompe nada runtime.

### Wave 3.5c — Mover frontend y app routes legacy (preservando la landing)

**No** mover (queda en árbol principal):

- `landing.html`.
- Todo `public/` salvo `architecture-explainer.html`. La inspección con `rg` confirma que los `compass-icon*`, `compass-logo*`, `compass-banner*`, `needle-mascot*` y `needle-hello/point/think/welcome` son assets de la landing/branding (referenciados o pendientes de wirear); ver detalle en [`inventory.md`](./inventory.md).
- `app/route.ts` (sirve la landing en `/`).
- `app/landing/route.ts` (redirect `/landing` → `/`).
- `app/layout.tsx` y `app/not-found.tsx`: se simplifican para no importar nada de `front/`.
- `scripts/build-favicon.mjs`: lo usa la landing (input `compass-logo-mark.png` → favicons). Queda en árbol principal.

Mover a `legacy/`:

- `front/**` entero (incluye `front/src/`, `front/docs/`, `front/README.md`) → `legacy/front/`.
- `app/home/**` (la app React vieja con chat/wallet UI) → `legacy/app/home/`.
- `app/dynamic-reset/**` → `legacy/app/dynamic-reset/`.
- `app/api/**` entero → `legacy/app/api/` (incluye los tres `route.test.ts` bajo `quotes/usdc-sol`, `wallet/transactions`, `wallet/balances`).
- `public/architecture-explainer.html` → `legacy/public/architecture-explainer.html` (su `<title>` es “Wallet Copilot”, marca previa al pivot).

Ajustes mínimos para que la landing siga viva:

- `app/layout.tsx` deja de importar `front/src/styles/globals.css`. La landing es HTML estático con CSS inline, no necesita Tailwind.
- En `landing.html`, reescribir cada `href="/home"` a `href="#flow"` y dejar un comment `<!-- TODO: re-point CTA to MCP Guard entrypoint once it exists -->` para que sea trivial revertirlo cuando exista el entrypoint nuevo.

Importante: tras esto, `npm run dev` y `npm run build` siguen funcionando porque sigue habiendo entrypoint válido en `/`. No queda Next compilando React legacy. `tsconfig.json` y `next.config.mjs` se ajustan para excluir `legacy/`.

Validación: `npm run test:back`, `npm run lint`, `npx tsc --noEmit`, `npm run build` verdes.

> **Heads up Vercel:** tras este merge, el deploy en Vercel queda sirviendo la landing en `/` pero todos los `/api/*` desaparecen. Si hay clientes apuntando a esos endpoints en prod, fallan. Es lo esperado: el chat-app deja de estar deployado.

### Wave 3.5d — Mover back/services legacy

Mover a `legacy/back/`:

- `back/README.md` → `legacy/back/README.md` (lista endpoints del chat-app). En 3.5h escribimos un README nuevo en `back/` para el universo MCP Guard.
- `back/.env.example` → `legacy/back/.env.example`. En 3.5h creamos un `back/.env.example` mínimo en árbol principal con `AGENT_ACTION_GUARD_PROGRAM_ID`, `SOLANA_RPC_URL`, opcional `WALLET_SAFETY_ATTESTOR_SECRET_KEY`.

Mover a `legacy/back/services/`:

- `chat.ts`, `chatSessionStore.ts`.
- `azureResponsesClient.ts`.
- `guardrailExplanations.ts`, `guardrailNarration.ts`.
- `walletHoldings.ts`, `transactionHistory.ts`, `conditionalOrders.ts`.
- `jupiter.ts`, `birdeye.ts`, `helius.ts`, `riskScore.ts`.
- `auth/appSession.ts`, `auth/dynamic.ts`.
- `tools/transfer.ts`, `tools/conditionalBuySol.ts`, `tools/orcaSwapTx.ts`, `tools/swapGuard.ts`, `tools/swapGuardOnChain.ts`.
- `tools/orcaSwap.ts`: mover **después** de extraer el helper de quote (ver Wave 3.5e).
- Tests asociados: `__tests__/chat.test.ts`, `chatSessionStore.test.ts`, `guardrailExplanations.test.ts`, `guardrailNarration.test.ts`, `azureResponsesClient.test.ts`, `walletHoldings.test.ts`, `conditionalBuySol.test.ts`, `orcaSwap.test.ts`, `appSession.test.ts`, `dynamicAuth.test.ts`.

Validación: `npm run test:back` (que ya excluye `legacy/`) sigue verde con los tests del guard, policy y transferGateway.

### Wave 3.5e — Romper la dependencia `priceQuote` → `tools/orcaSwap`

Hoy `back/services/priceQuote.ts` importa `quoteOrcaUsdcToSol` desde `tools/orcaSwap.ts`. Para mover `tools/orcaSwap.ts` a legacy sin romper transferGateway:

- Extraer el helper de quote a `back/services/priceProviders/orcaUsdcSol.ts` (módulo neutro, sin tooling de chat).
- Refactor `priceQuote.ts` para importar de ahí.
- Mover `tools/orcaSwap.ts` (el resto, swap-as-a-tool) a `legacy/back/services/tools/`.
- Tests de `priceQuote.test.ts` y `orcaSwap.test.ts` ajustados o reubicados según corresponda.

Validación: `npm run test:back` verde, `transferGateway.test.ts` sigue verde.

### Wave 3.5f — Rename `upstream.ts` → `envHttp.ts`

`upstream.ts` exporta `getEnv`, `jsonResponse`, `passthrough`. Lo usan tanto el guard nuevo (`walletSafetyValidation`) como los providers legacy (`jupiter`, `birdeye`, `helius`, `riskScore`, `azureResponsesClient`, `chat.ts`).

- Renombrar a `back/services/envHttp.ts` para evitar confusión semántica (“upstream” en MCP suena a upstream MCP, no a env helpers).
- Actualizar imports en el guard nuevo.
- En `legacy/`, dejar un re-export estable para no reescribir los archivos viejos: `legacy/back/services/upstream.ts` re-exporta desde `@back/envHttp` o desde una copia local. Decisión simple: copia local para que `legacy/` sea verdaderamente standalone.

Validación: `npm run test:back` verde.

### Wave 3.5g — Higiene de secretos (sin rotación en esta wave)

- **Decisión del usuario: no rotar ahora.** Los archivos siguen en disco.
- Asegurar que `credentials` y `dynamic_private_key` estén en `.gitignore` y, si están trackeados, sacarlos del tracking con `git rm --cached` (sin borrar el archivo local).
- Documentar el riesgo en `legacy/README.md`: `credentials` y `dynamic_private_key` siguen en disco como referencia; cualquier rotación/movimiento queda para una wave futura.

Esta sub-wave puede hacerse en paralelo o antes que las otras. Es independiente.

### Wave 3.5h — Documentación final

- Actualizar `README.md` y `AGENTS.md` para reflejar que el árbol principal es Compass MCP Guard y `legacy/` es referencia.
- `legacy/README.md` documenta cómo correr el legacy si alguien lo necesita (probablemente con `vitest.legacy.config.ts` y un `next.config.legacy.mjs`).
- `docs/api-reference.md` se mueve a `legacy/docs/` y se deja un placeholder en `docs/` para la futura API del MCP Guard.

## Política de ramas

- Esta wave se hace en `feature/wave-3.5-legacy-isolation`, salida desde `release/compass_migration`.
- Cada sub-wave puede ser un PR separado dentro de esa rama (sub-feature branches `feature/wave-3.5a-plumbing`, `feature/wave-3.5b-docs-move`, etc.), o todo en un solo PR si preferís.
- Wave 3 (`3013dc7`) sigue en `feature/wave-3-transfer-behind-gateway`. Antes de empezar 3.5 conviene mergearla a `release/compass_migration`.

## Riesgos

1. **Tests acoplados.** `chat.test.ts` espera `evaluateTransferGateway` montado en `chat.ts`. Si movemos `chat.ts` a `legacy/`, ese test va con él y no corre en `test:back`. Decisión propuesta: aceptarlo. El guard nuevo tiene sus tests propios (`transferGateway.test.ts`).
2. **Dependencias npm huérfanas.** Dynamic, Radix UI, Tailwind, langchain, langgraph, supabase quedarán usadas solo por `legacy/`. No las desinstalamos en esta wave para no romper el legacy. Limpieza diferida.
3. **TypeScript paths.** `@/*`, `@front/*` apuntan a `front/src`. Al mover front a legacy, hay que mantener esos paths para `legacy/`, o reescribir imports. Decisión propuesta: dejar paths actuales pero con `exclude legacy/**` en el tsconfig principal; `legacy/tsconfig.json` se encarga aparte.
4. **Reformateo de `chat.ts` en Wave 3.** El commit `3013dc7` reformateó `chat.ts` entero. Eso significa que el diff del move a `legacy/` será limpio en términos de contenido, pero `git log --follow` puede perderse. No es bloqueante.
5. **Vercel deployment cambia silenciosamente.** Tras 3.5c, el deploy de Vercel deja de exponer `/api/*`. La landing en `/` sigue viva. Si hay observability/checks contra esas rutas, hay que pausarlos o aceptar el ruido.
6. **Secretos en git history.** Decisión del usuario: no rotamos en esta wave. Si `credentials` y `dynamic_private_key` tienen valores reales, queda pendiente rotarlos más adelante. La historia de git no se reescribe ahora.
7. **`npm run build` y la landing.** Sigue verde porque `app/route.ts` + `landing.html` viven en árbol principal. Único cuidado: quitar el import a `front/src/styles/globals.css` en `app/layout.tsx` antes de mover `front/`.

## Decisiones (confirmadas con el usuario)

1. **`legacy/` es una carpeta del repo**, no submodule ni branch huérfana.
2. **CTAs de la landing**: cada `href="/home"` pasa a `href="#flow"` durante 3.5c, con `<!-- TODO -->` para revertir cuando exista el entrypoint MCP Guard.
3. **`openspec/`** se mueve a `legacy/sdd/openspec/` en 3.5b junto con el resto de SDD legacy (AGENTS exige una sola fuente y es `docs/`).
4. **No rotamos secretos en esta wave.** `credentials` y `dynamic_private_key` quedan donde están. Wave 3.5g se reduce a confirmar que estén en `.gitignore` y documentar el riesgo; cualquier rotación queda para otra wave/decisión del usuario.
5. **`public/` queda entero en árbol principal** salvo `architecture-explainer.html` (marca anterior “Wallet Copilot”, legacy).

## Próximos pasos si aprobás

1. Crear branch `feature/wave-3.5-legacy-isolation` desde `release/compass_migration`.
2. Ejecutar **3.5a** primero (plumbing/guardrails, sin mover archivos) para que el tooling ya bloquee imports cruzados.
3. Después, **3.5b → 3.5h** en el orden propuesto. Cada uno con `npm run test:back && npm run lint && npx tsc --noEmit` verde antes de avanzar.
4. Al final, mergeamos `feature/wave-3.5-legacy-isolation` a `release/compass_migration`. `main` sigue intocado.
