# Development workflow

Guía corta para trabajar en este repo después de la separación `front/` / `back/`.

## Quick path

```bash
npm install --registry=https://registry.npmjs.org
npm run dev
npm test
npm run test:back
npm run lint
npm run build
```

La app se deploya como **una sola aplicación Next.js**. No hay servidores separados para `front` y `back`.

## Scripts

| Comando | Scope real | Cuándo usarlo |
|---|---|---|
| `npm run dev` | Next app completa | Desarrollo local normal. |
| `npm run dev:front` | Alias de `next dev` | Conveniencia; no levanta un frontend separado. |
| `npm run dev:back` | Alias de `next dev` | Conveniencia; no levanta un backend separado. |
| `npm run build` | Next app completa | Verificación de producción/Vercel. |
| `npm run build:front` | Alias de `next build` | Conveniencia; no es un build separado de frontend. |
| `npm test` | Tests de `front/src` | Unit/component tests del frontend. |
| `npm run test:front` | Alias de `vitest --run` | Igual que `npm test`. |
| `npm run test:back` | Tests de `back/services` y `app/api` | Servicios backend y route handlers. |
| `npm run test:watch` | Vitest watch | Desarrollo TDD interactivo. |
| `npm run lint` | `app`, `front/src`, `back/services` | Lint de TypeScript/React en áreas runtime. |
| `npm run bootstrap:conditional` | Script devnet | Bootstrap de demo conditional escrow en devnet. |

## Aliases TypeScript

Definidos en `tsconfig.json` y replicados en Vitest:

| Alias | Apunta a | Uso |
|---|---|---|
| `@/*` | `front/src/*` | Imports de UI/hooks/lib frontend. |
| `@front/*` | `front/src/*` | Alias explícito de frontend. |
| `@back/*` | `back/*` | Imports server-side desde route handlers/tests. |
| `@shared/*` | `shared/*` | Tipos/utilidades seguros para ambos lados. |

Regla práctica: no importes `back/*` desde componentes/hook browser-side. El cruce permitido es `front -> /api/* -> app/api -> back/services`.

## Dynamic wallet auth local setup

Para probar la migración wallet-first con Dynamic:

1. Configurá `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` en `.env.local` con el Environment ID público de Dynamic.
2. Configurá `APP_SESSION_SECRET` para activar validación de sesión app-side en backend local.
3. Opcional: configurá `DYNAMIC_ENVIRONMENT_ID` para verificar JWT Dynamic vía JWKS server-side.
4. Corré `npm run dev` y conectá una wallet Solana externa o embedded desde el modal Dynamic.

Sin `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`, el provider Dynamic queda deshabilitado y `useWallet` conserva el fallback Phantom para desarrollo legacy.

## Tests

| Config | Include | Entorno |
|---|---|---|
| `vitest.config.ts` | `front/src/**/*.{test,spec}.?(c|m)[jt]s?(x)` | `jsdom` |
| `vitest.back.config.ts` | `back/services/**/*` y `app/api/**/*` | `node` |

Si una feature toca UI y backend, corré ambos:

```bash
npm test
npm run test:back
```

## Lint y TypeScript

- `strict` está actualmente en `false`; no lo uses como permiso para sumar tipos ambiguos.
- Evitá `any`; preferí tipos de contratos en `front/src/types` o `shared/`.
- `front/src/main.tsx` está excluido del build TS porque la app real entra por Next (`app/page.tsx`).
- `*.tsbuildinfo` está ignorado y no debe commitearse.

## Checklist antes de pedir review

- [ ] `npm test` pasa.
- [ ] `npm run test:back` pasa si tocaste backend/API.
- [ ] `npm run lint` no tiene errores.
- [ ] `npm run build` pasa si tocaste rutas, configs o imports globales.
- [ ] Actualizaste `docs/api-reference.md` si cambiaste `app/api/*`.
- [ ] Actualizaste specs en `docs/<feature>/` si cambiaste comportamiento de feature.
