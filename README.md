# Wallet Copilot — Separación front / back en Next.js

Este proyecto está organizado como una **Next.js fullstack app** deployable en Vercel, pero mantiene una separación física clara entre frontend y backend.

La idea es tener el código separado para trabajar ordenadamente, pero que a nivel de deploy funcione como **una sola aplicación Next**.

## Documentación rápida

| Necesitás | Leé |
|---|---|
| APIs internas y contratos | `docs/api-reference.md` |
| Scripts, tests, aliases y workflow | `docs/development-workflow.md` |
| Direcciones devnet/on-chain | `docs/onchain-deployments.md` |
| Índice de specs por feature | `docs/README.md` |
| Frontend | `front/README.md` |
| Backend | `back/README.md` |
| Código compartido | `shared/README.md` |

---

## Estructura general

```txt
.
├── app/
│   ├── page.tsx
│   ├── layout.tsx
│   ├── not-found.tsx
│   └── api/
│       ├── jupiter/quote/route.ts
│       ├── birdeye/token-security/route.ts
│       ├── risk-score/route.ts
│       └── helius/transactions/route.ts
│
├── front/
│   ├── README.md
│   ├── docs/
│   └── src/
│       ├── App.tsx
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── providers/
│       ├── stores/
│       ├── styles/
│       └── types/
│
├── back/
│   ├── README.md
│   ├── services/
│   ├── solana/
│   └── sdd/
│
├── shared/
│   └── README.md
│
├── docs/
│   ├── README.md
│   └── <feature-name>/
│       ├── functional-spec.md
│       ├── technical-spec.md
│       └── task.json
│
├── app/
├── package.json
├── next.config.mjs
├── tsconfig.json
└── README.md
```

---

## Qué es `front/`

`front/` contiene todo el código de interfaz y lógica client-side.

Ahí viven:

- componentes React,
- pantallas,
- hooks,
- estilos,
- lógica de UI,
- providers client-side,
- lógica que puede ejecutarse en el navegador.

Ejemplo:

```txt
front/src/App.tsx
front/src/components/
front/src/hooks/
front/src/lib/
front/src/providers/
front/src/stores/
front/src/styles/
front/src/types/
```

El frontend **no debe contener secrets ni API keys privadas**.

Si una integración necesita una API key, el frontend debe llamar a una ruta interna `/api/...`, y esa ruta debe resolver la llamada desde el backend.

---

## Qué es `back/`

`back/` contiene la lógica server-side reutilizable.

Esta carpeta no levanta un servidor separado. No hay un `server.js` corriendo aparte.

En cambio, `back/services/*` contiene funciones que son usadas por las rutas API de Next en `app/api/*`.

Ejemplo:

```txt
app/api/birdeye/token-security/route.ts
```

usa:

```txt
back/services/birdeye.ts
```

De esta forma mantenemos separación física:

```txt
front/ -> UI
back/  -> lógica backend
```

pero el deploy sigue siendo una sola aplicación Next en Vercel.

---

## Qué es `app/`

`app/` es la carpeta estándar de Next.js App Router.

Tiene dos responsabilidades:

1. Exponer la app frontend.
2. Exponer las rutas backend mediante Route Handlers.

### Frontend entrypoint

```txt
app/page.tsx
```

importa el frontend real desde:

```txt
front/src/App.tsx
```

Es decir, Next renderiza la página desde `app/page.tsx`, pero el código visual está en `front/`.

### Backend entrypoints

Las APIs públicas internas viven en:

```txt
app/api/*/route.ts
```

La referencia canónica está en `docs/api-reference.md`. Resumen actual:

| Área | Rutas |
|---|---|
| Chat/agent | `/api/chat` |
| Conditional orders | `/api/conditional-orders`, `/api/conditional-orders/[orderPda]` |
| Wallet | `/api/wallet/balances`, `/api/wallet/transactions`, `/api/wallet/allocation` |
| Quotes/prices | `/api/quotes/usdc-sol`, `/api/jupiter/quote`, `/api/prices` |
| Risk/providers | `/api/birdeye/token-security`, `/api/risk-score`, `/api/helius/transactions` |
| Network | `/api/network/status` |

Estas rutas son las que Vercel convierte en funciones server-side.

---

## Flujo de una llamada frontend → backend

Ejemplo con Birdeye:

```txt
front/src/lib/risk/providers/BirdeyeTokenSecurityProvider.ts
```

llama a:

```txt
/api/birdeye/token-security?mint=<mint>
```

Next recibe esa request en:

```txt
app/api/birdeye/token-security/route.ts
```

Ese route handler llama a:

```txt
back/services/birdeye.ts
```

Y recién ahí se usa la API key privada desde variables de entorno del servidor.

Resumen:

```txt
Browser
  -> /api/birdeye/token-security
    -> app/api/birdeye/token-security/route.ts
      -> back/services/birdeye.ts
        -> Birdeye API externa
```

---

## Por qué está separado así

Esta estructura permite:

- mantener el frontend y backend separados en el código,
- evitar un deploy doble,
- usar Vercel como una sola app Next,
- proteger API keys en server-side env vars,
- evitar CORS entre frontend y backend,
- seguir el estándar de Next.js para rutas backend.

---

## Variables de entorno

Las variables privadas del backend deben configurarse en Vercel o en `.env.local` en la raíz. La matriz completa vive en `back/README.md`.

Grupos principales:

| Grupo | Variables típicas | Uso |
|---|---|---|
| Agent/LLM | `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, `OPENAI_API_URL` | Chat agentic y opiniones textuales. |
| Providers | `BIRDEYE_*`, `HELIUS_*`, `RISK_SCORE_*`, `JUPITER_API_URL` | Datos externos y scoring server-side. |
| Chat store | `CHAT_SESSION_REDIS_REST_*`, `UPSTASH_REDIS_REST_*`, `KV_REST_API_*` | Persistencia de sesiones en Vercel. |
| Solana/devnet | Ver `docs/onchain-deployments.md` y `.env.example` | Program IDs, mints, feeds y keeper opcional. |

El frontend solo puede usar variables públicas con prefijo:

```txt
NEXT_PUBLIC_*
```

No poner secrets en `front/`.

---

## Contract deployment addresses

Las direcciones devnet están documentadas en `docs/onchain-deployments.md`.

Resumen:

- AgentActionGuard program: `4K9mRmHmbFGgDN8Luhx5hPRHwuEZ5kQm2VNpMUr1gaBV`
- ConditionalEscrowBuy program: `FDwvY7eqeCNn27haATZJbqfnACJTr9YveG6yy9RcUt7u`
- No hay deployment mainnet configurado para esta demo.

---

## Scripts

La guía completa está en `docs/development-workflow.md`.

| Comando | Qué hace |
|---|---|
| `npm install --registry=https://registry.npmjs.org` | Instala dependencias. |
| `npm run dev` | Levanta la app Next completa. |
| `npm run build` | Build de producción. |
| `npm test` | Tests frontend (`front/src`). |
| `npm run test:back` | Tests backend/API (`back/services`, `app/api`). |
| `npm run lint` | Lint de `app`, `front/src`, `back/services`. |
| `npm run bootstrap:conditional` | Bootstrap devnet de conditional escrow. |

`dev:front`, `dev:back` y `build:front` son aliases de conveniencia: no representan deploys separados.

---

## Deploy en Vercel

Deployar la raíz del repo como una app Next.js.

Configuración esperada:

```txt
Framework: Next.js
Root Directory: ./
Build Command: npm run build
```

No hay que deployar `front/` y `back/` por separado.

Vercel detecta:

- `app/page.tsx` como frontend,
- `app/api/*/route.ts` como backend.

---

## Regla de oro

```txt
front/ = código que puede correr en el navegador
back/  = lógica server-side reutilizable
app/   = entrypoints oficiales de Next para páginas y APIs
```

Si algo necesita una API key privada, va en `back/services/*` y se expone mediante `app/api/*/route.ts`.
