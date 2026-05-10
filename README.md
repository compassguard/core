# Wallet Copilot — Separación FRONT / BACK en Next.js

Este proyecto está organizado como una **Next.js fullstack app** deployable en Vercel, pero mantiene una separación física clara entre frontend y backend.

La idea es tener el código separado para trabajar ordenadamente, pero que a nivel de deploy funcione como **una sola aplicación Next**.

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
├── FRONT/
│   └── src/
│       ├── App.tsx
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── pages/
│       └── index.css
│
├── BACK/
│   └── services/
│       ├── jupiter.ts
│       ├── birdeye.ts
│       ├── riskScore.ts
│       ├── helius.ts
│       └── upstream.ts
│
├── shared/
│   └── README.md
│
├── package.json
├── next.config.mjs
├── tsconfig.json
└── README.md
```

---

## Qué es `FRONT/`

`FRONT/` contiene todo el código de interfaz y lógica client-side.

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
FRONT/src/App.tsx
FRONT/src/components/
FRONT/src/hooks/
FRONT/src/lib/
FRONT/src/pages/
```

El frontend **no debe contener secrets ni API keys privadas**.

Si una integración necesita una API key, el frontend debe llamar a una ruta interna `/api/...`, y esa ruta debe resolver la llamada desde el backend.

---

## Qué es `BACK/`

`BACK/` contiene la lógica server-side reutilizable.

Esta carpeta no levanta un servidor separado. No hay un `server.js` corriendo aparte.

En cambio, `BACK/services/*` contiene funciones que son usadas por las rutas API de Next en `app/api/*`.

Ejemplo:

```txt
app/api/birdeye/token-security/route.ts
```

usa:

```txt
BACK/services/birdeye.ts
```

De esta forma mantenemos separación física:

```txt
FRONT/ -> UI
BACK/  -> lógica backend
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
FRONT/src/App.tsx
```

Es decir, Next renderiza la página desde `app/page.tsx`, pero el código visual está en `FRONT/`.

### Backend entrypoints

Las APIs públicas internas viven en:

```txt
app/api/*/route.ts
```

Por ejemplo:

```txt
app/api/jupiter/quote/route.ts
app/api/birdeye/token-security/route.ts
app/api/risk-score/route.ts
app/api/helius/transactions/route.ts
```

Estas rutas son las que Vercel convierte en funciones server-side.

---

## Flujo de una llamada frontend → backend

Ejemplo con Birdeye:

```txt
FRONT/src/lib/risk/providers/BirdeyeTokenSecurityProvider.ts
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
BACK/services/birdeye.ts
```

Y recién ahí se usa la API key privada desde variables de entorno del servidor.

Resumen:

```txt
Browser
  -> /api/birdeye/token-security
    -> app/api/birdeye/token-security/route.ts
      -> BACK/services/birdeye.ts
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

Las variables privadas del backend deben configurarse en Vercel o en `.env.local` en la raíz.

Ejemplos:

```txt
BIRDEYE_API_KEY=
BIRDEYE_API_URL=https://public-api.birdeye.so

HELIUS_API_KEY=
HELIUS_API_URL=https://api.helius.xyz

RISK_SCORE_API_KEY=
RISK_SCORE_API_URL=

JUPITER_API_URL=https://lite-api.jup.ag/swap/v1

# Store externo para sesiones de chat en Vercel
CHAT_SESSION_REDIS_REST_URL=
CHAT_SESSION_REDIS_REST_TOKEN=
```

El frontend solo puede usar variables públicas con prefijo:

```txt
NEXT_PUBLIC_*
```

No poner secrets en `FRONT/`.

Para el store de sesiones también se aceptan las variables estándar de Upstash/Vercel KV:
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` o `KV_REST_API_URL` / `KV_REST_API_TOKEN`.

---

## Contract deployment addresses

Devnet contracts and on-chain accounts used by the current demo deployment:

| Name | Network | Address |
| --- | --- | --- |
| AgentActionGuard program | devnet | `4K9mRmHmbFGgDN8Luhx5hPRHwuEZ5kQm2VNpMUr1gaBV` |
| AgentActionGuard attestor config PDA | devnet | `AZuL6voaDa58HHx9Pw7goWRmQxndehkwQsvV8Hbz9huM` |
| Wallet safety attestor authority | devnet | `7sSydc547d2fZ4FMbJVezSVjXK1btAjwU9H2wDWjeKnW` |
| ConditionalEscrowBuy program | devnet | `FDwvY7eqeCNn27haATZJbqfnACJTr9YveG6yy9RcUt7u` |
| devUSDC mint (`USDC_TEST_MINT`) | devnet | `BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k` |
| Treasury devUSDC ATA (`TREASURY_USDC_ATA`) | devnet | `36o9VaNwtfWiAJGfYKao3ZbxmFAye8brMjLEhE4Jv1TC` |
| Pyth SOL/USD feed (`PYTH_SOL_USD_FEED`) | devnet | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| Orca SOL/devUSDC Whirlpool pool | devnet | `3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt` |
| SPL Token program | devnet | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Associated Token program | devnet | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |

No mainnet contract deployment is configured for this demo.

---

## Scripts

Instalar dependencias:

```bash
npm install --registry=https://registry.npmjs.org
```

Correr en desarrollo:

```bash
npm run dev
```

Build de producción:

```bash
npm run build
```

Correr tests:

```bash
npm run test
```

Lint:

```bash
npm run lint
```

---

## Deploy en Vercel

Deployar la raíz del repo como una app Next.js.

Configuración esperada:

```txt
Framework: Next.js
Root Directory: ./
Build Command: npm run build
```

No hay que deployar `FRONT/` y `BACK/` por separado.

Vercel detecta:

- `app/page.tsx` como frontend,
- `app/api/*/route.ts` como backend.

---

## Regla de oro

```txt
FRONT/ = código que puede correr en el navegador
BACK/  = lógica server-side reutilizable
app/   = entrypoints oficiales de Next para páginas y APIs
```

Si algo necesita una API key privada, va en `BACK/services/*` y se expone mediante `app/api/*/route.ts`.
