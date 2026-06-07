# Pre-execution review notes — Wave 3.5

Pase adversarial sobre el plan antes de tocar archivos. Cada item se aplica a `proposal.md` y/o `inventory.md` según corresponda.

## Hallazgos confirmados (OK)

- **No hay CI workflows** (`.github/workflows/` no existe). No hay que tocar pipelines.
- **`next.config.mjs`** es mínimo (`reactStrictMode: true`). Solo le agregamos exclude/redirect si hace falta; no hay paths legacy hardcodeados.
- **`shared/`** solo tiene un README; es candidato natural para contratos compartidos del MCP Guard. Queda como `repo_infra` placeholder.
- **`.gitignore` ya excluye** `credentials`, `credentials/`, `dynamic_private_key`, `*.pem`, `*.key`. `git ls-files credentials dynamic_private_key` retorna vacío. **Wave 3.5g queda como verificación, no como remediation activa.**
- **`progress.md`** ya está en `.gitignore` (sólo local). No requiere movimiento.
- **Anchor builds** (`**/target/`, `.anchor/`, `test-ledger/`) gitignored. `back/solana/*` programs y `Cargo.lock` quedan en árbol principal como `new_guard`.

## Gaps reales encontrados (hay que editar specs)

### G1. `back/.env.example` quedó sin clasificar y es legacy

Contenido: `DYNAMIC_*`, `BIRDEYE_*`, `RISK_SCORE_*`, `HELIUS_*`, `OPENAI_*`, `JUPITER_*`, `APP_SESSION_SECRET`. Todas variables del producto viejo o del LLM-as-chat. Tras Wave 3.5d, los servicios que las leen viven en `legacy/`.

**Acción:** mover `back/.env.example` a `legacy/back/.env.example` y crear un nuevo `back/.env.example` mínimo en árbol principal con `AGENT_ACTION_GUARD_PROGRAM_ID` y `SOLANA_RPC_URL` (los que sí necesita `walletSafetyValidation`/`onchainApproval`/`priceQuote`).

### G2. `back/README.md` describe la API del chat-app

Lista endpoints `/api/chat`, `/api/conditional-orders`, `/api/wallet/*`, etc. Todos legacy. Tampoco refleja el norte MCP Guard.

**Acción:** mover a `legacy/back/README.md`. En 3.5h escribimos un README nuevo para el árbol principal que describa el universo MCP Guard (gateway/policy/transferGuard/audit/programs).

### G3. `front/docs/` y `front/README.md` son del producto viejo

`front/` es un subárbol con docs propias (`front/docs/T1-*`, `T3-*`, technical-spec, etc.).

**Acción:** el move de Wave 3.5c es `front/**` entero (no `front/src/**`). Quedó implícito; lo dejo explícito en proposal/inventory.

### G4. ESLint config es flat (`eslint.config.js`)

Hoy ignora `.next`, `node_modules`, `front/dist`, `dist`, `build`. La regla `no-restricted-imports` aplicada en flat config necesita el shape correcto:

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

Además agregar `legacy/**` al `ignores` global para que ESLint no recorra legacy en `npm run lint`.

**Acción:** documentar el snippet exacto en la sección de Wave 3.5a del proposal.

### G5. `tsconfig.json include` recoge `**/*.ts`

Como `legacy/**/*.ts` matchea, hay que excluirlo explícitamente.

**Acción:** en Wave 3.5a sumar `"legacy/**"` al `exclude`. Confirmado: `tsconfig.json` no tiene paths que rompan con esto; los aliases `@/*`, `@front/*` solo sirven en el árbol viejo, así que se mantienen para que `legacy/` siga compilando aparte si hace falta.

### G6. Vitest backend incluye `app/api/**/*.{test,spec}.*`

Hay tres tests reales bajo `app/api/`:

- `app/api/quotes/usdc-sol/route.test.ts`
- `app/api/wallet/transactions/route.test.ts`
- `app/api/wallet/balances/route.test.ts`

Tras mover `app/api/**` a `legacy/`, esos tests dejan de existir en el árbol principal. Vitest seguirá verde porque el `include` apunta a paths que ya no existen.

**Acción:** agregar `"exclude": ["legacy/**"]` defensivo a `vitest.back.config.ts` y `vitest.config.ts` en Wave 3.5a, aunque no haya ya nada por capturar.

### G7. Vercel deployment va a romper para `/api/*`

Hay `.vercel/` local (deploy configurado). Tras Wave 3.5c, los endpoints `/api/*` dejan de existir en árbol principal. El home estático (`/`) sigue funcionando. Esto cambia el comportamiento del producto deployado.

**Acción:** documentar este riesgo en la sección de riesgos del proposal y avisar antes del merge de 3.5c.

### G8. Layout legacy de la carpeta `legacy/`

En `proposal.md` el árbol de ejemplo todavía dice `legacy/public/` y `legacy/landing.html`. Eso quedó obsoleto cuando decidimos que la landing y `public/` se quedan en árbol principal.

**Acción:** corregir el árbol de ejemplo. `legacy/public/` solo contiene `architecture-explainer.html`; `legacy/landing.html` no existe.

### G9. `scripts/build-favicon.mjs` está al servicio de la landing

Genera `compass-icon.png` (256) y `compass-icon-32.png` desde `compass-logo-mark.png`. Esos iconos los usa `landing.html` y `app/layout.tsx`. No es legacy.

**Acción:** marcar `scripts/build-favicon.mjs` como `shared_keep` (estaba como `legacy_strict`).

### G10. `OrcaSwapParams` también vive en `front/src/types/api.ts` y se usa en `front/src/lib/api/schemas.ts`

Son tipos del frontend para validar payloads del chat. No coupling con el backend `OrcaSwapParams`. Ambos universos van a legacy (front entero y backend tools).

**Acción:** sin cambio funcional. Lo dejo anotado para no confundir el refactor de Wave 3.5e: la extracción del helper `quoteOrcaUsdcToSol` solo toca `back/services/`, no `front/`.

### G11. `scripts/bootstrap-conditional-devnet.mjs` toca `conditional-escrow-buy` (program nuevo)

El script bootstrap-ea devnet para el program. El program queda en `new_guard`, pero el script es ad-hoc del producto viejo y, además, hardcodea `ORCA_DEVNET_USDC_MINT` localmente.

**Acción:** mantenerlo en `legacy/scripts/` por ahora. Si el MCP Guard necesita bootstrap más adelante, lo extraemos. Anotarlo en `inventory.md`.

### G12. `sdd/done/*` está tracked y es del producto viejo

Sólo había revisado `sdd/wip/`. `sdd/done/003-approve-swap-oracle-guard-execution/spec.md` y `004-swap-guard-warning-bypass/spec.md` también son legacy.

**Acción:** sumar `sdd/done/` al move de Wave 3.5b.

### G13. ¿Mover `architecture-explainer.html` o borrarlo?

La política es "no borramos, aislamos". Lo movemos a `legacy/public/architecture-explainer.html`. Pero queda accesible si alguien le pone la URL `/architecture-explainer.html`. Bajo Next.js, los archivos en `public/` se sirven directamente. Si lo movemos a `legacy/public/`, deja de servirse.

**Acción:** confirmado, mover lo saca del bucket público de Next, que es lo que queremos. No hay acción adicional.

### G14. `app/page.tsx` no existe

Con Next 15 App Router, `app/route.ts` (handler GET) en `/` reemplaza a `app/page.tsx`. La landing funciona vía route handler que lee `landing.html` y devuelve HTML. No requiere placeholder de page.tsx.

**Acción:** confirmado, ya estaba bien implícito. Sin cambio.

## Sin cambios — pero anotaciones para 3.5a

- **`back/services/__tests__/priceQuote.test.ts`** hace `vi.spyOn(orca, 'quoteOrcaUsdcToSol')`. Tras 3.5e, ese spy apuntará al nuevo módulo `priceProviders/orcaUsdcSol.ts`. El test sigue funcionando con un cambio de import.
- **`back/services/tools/orcaSwap.ts`** redeclara `DEVNET_USDC_MINT`, `DEVNET_SOL_MINT`, `DEVNET_SOL_USDC_POOL`. Cuando extraigamos el quote a `priceProviders/orcaUsdcSol.ts`, esos constants deberían vivir en `solanaNetworkConfig.ts` (donde ya existe `DEVNET_USDC_MINT`) o en el propio price provider. Eso evita duplicación.
- **`back/services/chat.ts`** importa `DEVNET_USDC_MINT, quoteOrcaUsdcToSol, OrcaSwapParams` desde `tools/orcaSwap`. Como `chat.ts` va a `legacy/`, sigue usando la copia legacy de `tools/orcaSwap.ts`. No bloquea la extracción del price provider para el árbol principal.

## Decisiones que el reviewer adversarial sugeriría discutir antes de empezar

1. ¿Reescribimos `back/README.md` y `README.md` raíz en 3.5h o nos alcanza con notas + TODO?
   - **Sugerencia:** README raíz en 3.5h (descripción del producto nuevo); `back/README.md` nuevo mínimo apuntando a las piezas MCP Guard.
2. ¿`shared/` se queda como placeholder o se aprovecha para mover ya tipos canonicos del guard que hoy viven en `back/`?
   - **Sugerencia:** dejar `shared/` quieto en esta wave; no introduce valor mover tipos que solo usa backend.
3. ¿El nuevo `.env.example` del árbol principal incluye sólo lo crítico o un listado más amplio?
   - **Sugerencia:** mínimo: `AGENT_ACTION_GUARD_PROGRAM_ID`, `SOLANA_RPC_URL`, opcional `WALLET_SAFETY_ATTESTOR_SECRET_KEY` (lo usa `walletSafetyValidation`).

## Resumen

Bloqueos críticos: **ninguno**. El plan principal es correcto; las correcciones son ajustes de alcance, no de dirección. Después de aplicar G1–G9 sobre `proposal.md` e `inventory.md`, podemos arrancar Wave 3.5a con confianza.
