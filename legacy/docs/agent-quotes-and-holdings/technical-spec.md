# Technical Spec - Agent Quotes And Holdings

Version: 1
Status: Planned
Date: 2026-05-10
Source: user request + explorer handoff

## Arquitectura propuesta

La feature sigue la arquitectura existente del proyecto:

1. `back/services/*` contiene integraciones con providers y normalizacion.
2. `app/api/*` expone contratos HTTP internos para frontend o capas servidoras.
3. `back/services/chat.ts` agrega herramientas de solo lectura para el agente.

Se proponen dos capacidades separadas:

- `holdings`: fuente de verdad de tokens y montos de la wallet del usuario
- `quote`: cotizacion USDC/SOL compatible con Solana `devnet`

La red de esta feature es `devnet` solamente. Cualquier parametro, sesion o config que intente usar `mainnet-beta` debe rechazarse de forma explicita.

## Decision principal

Se usaran herramientas explicitas de solo lectura para el agente, en lugar de depender solo de un prefetch implícito en cada `user_message`.

Razon:

- hace trazable cuando el agente consulto data real
- permite reusar la misma logica desde API routes y desde chat backend
- reduce riesgo de usar contexto stale o incompleto

Un prefetch opcional puede agregarse despues como optimizacion, pero no es el contrato base de esta spec.

## Componentes

### Holdings service

Crear un servicio backend dedicado, por ejemplo `back/services/walletHoldings.ts`, que:

- valide `address` y `network`
- obtenga SOL nativo via RPC
- obtenga holdings SPL del usuario via RPC/backend provider
- normalice balances al contrato `TokenBalance`
- excluya cuentas vacias o dust no parseable segun reglas documentadas
- devuelva `updated_at`

Debe seguir el patron defensivo ya usado en `back/services/transactionHistory.ts`:

- timeout/abort
- validacion de inputs
- parseo defensivo
- errores backend estables

### Quote service

Agregar un servicio backend dedicado, por ejemplo `back/services/priceQuote.ts`, que:

- resuelva mints canonicos SOL/USDC para `devnet`
- reutilice o envuelva el servicio devnet existente de Orca USDC/SOL cuando este disponible
- opcionalmente use un provider devnet alternativo configurado, pero sin caer silenciosamente a mainnet
- normalice una respuesta compacta para el agente y para API routes
- devuelva `updated_at` y un `provider` explicito

La cotizacion definida por esta spec es:

- par fijo: `USDC <-> SOL`
- red fija: `devnet`
- semantica: quote indicativa de conversion en devnet
- no reemplaza un futuro market price service multipar

### API routes

Se proponen estas rutas:

- extender `app/api/wallet/balances/route.ts` para devolver holdings reales de SOL + SPL
- agregar `app/api/quotes/usdc-sol/route.ts` para quote normalizado del par USDC/SOL

Decision sobre `app/api/prices/route.ts`:

- no debe seguir siendo la fuente para el agente
- puede quedar legacy/mock para otras pantallas hasta que otra feature lo reemplace
- esta feature no debe depender de ese endpoint

### Chat tools

Agregar en `back/services/chat.ts` dos herramientas read-only:

- `get_wallet_holdings`
- `get_usdc_sol_quote`

Ambas deben:

- aceptar solo parametros minimos y validados
- trabajar con `user_address` y red de la sesion
- no preparar ni ejecutar transacciones
- devolver payloads pequenos y deterministas

## Contratos propuestos

### Holdings

```ts
type AgentWalletHoldingsParams = {
  address: string;
  network?: 'devnet';
};

type AgentWalletHoldingsResult = {
  network: 'devnet';
  balances: TokenBalance[];
  total_usd: number;
  updated_at: string;
  source: 'rpc';
};
```

Notas:

- `TokenBalance` debe mantenerse alineado con `front/src/types/api.ts`.
- `total_usd` puede quedar en `0` o con suma parcial si no existe valuacion confiable para todos los tokens; esto debe documentarse y no inferirse.
- `updated_at` debe ser ISO.

### Quote

```ts
type UsdcSolQuoteParams = {
  network?: 'devnet';
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  slippage_bps?: number;
};

type UsdcSolQuoteResult = {
  network: 'devnet';
  provider: 'orca_whirlpools_devnet' | 'pyth_devnet' | 'configured_devnet_quote';
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  output_amount: number;
  input_mint: string;
  output_mint: string;
  route_context?: string;
  updated_at: string;
};
```

Reglas:

- solo se aceptan combinaciones `USDC -> SOL` y `SOL -> USDC`
- solo se acepta `network = "devnet"`
- `input_amount` debe ser positivo
- `updated_at` representa el momento de consulta, no una garantia de vigencia

## Recuperacion de holdings

Fuente de verdad:

- backend RPC/provider, nunca frontend

Detalle esperado:

- SOL nativo via `getBalance`
- tokens SPL via cuentas token del owner
- normalizacion usando decimals reales del mint/cuenta
- exclusion de cuentas con `ui_amount = 0` cuando no aporten contexto util

Tratamiento de edge cases:

- `SOL` y `WSOL` no deben mezclarse como el mismo activo si la fuente devuelve ambos
- no usar `symbol` como identificador unico; el identificador canonico es `mint`
- manejar zero balances y dust sin inflar holdings
- no devolver activos con amounts corruptos o no parseables

## Recuperacion de quote

Fuente de verdad:

- proveedor/servicio backend compatible con `devnet`
- el repo ya tiene referencia devnet en `back/services/tools/orcaSwap.ts` con:
  - `DEVNET_USDC_MINT = BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k`
  - `DEVNET_SOL_MINT = So11111111111111111111111111111111111111112`
  - `provider = orca_whirlpools_devnet`
- Jupiter no debe ser dependencia obligatoria de esta feature mientras el requisito sea funcionar en `devnet`

Decision de red y mints:

- agregar una configuracion backend compartida para mints SOL/USDC de `devnet`
- evitar que frontend sea la fuente canonica de mints
- la red usada en quote y holdings debe ser siempre `devnet`

Freshness:

- las respuestas a quote deben ser `cache: no-store` cuando pasen por API route
- la respuesta normalizada debe incluir `updated_at`
- si se implementa TTL de app, debe ser corto y explicito; para esta spec se asume que el quote es efimero y se consulta on-demand

## Guardrails y seguridad

- ningun provider key sale al frontend
- el agente solo recibe herramientas read-only para holdings y quote
- la feature debe validar `address`, `network`, amounts y token pair antes de tocar providers
- no debe existir fallback automatico a mainnet
- cualquier request distinta de `devnet` debe retornar error estable
- errores de provider deben mapearse a errores backend estables, sin filtrar secretos
- los mensajes del agente deben tratar la quote como indicativa y no como resultado garantizado

## Riesgos principales

- uso accidental de mints mainnet en una feature que debe funcionar en devnet
- decimals incorrectos o conversiones float inseguras
- confusion entre SOL nativo y WSOL
- cuentas SPL vacias o dust que ensucien el contexto del agente
- timeouts o rate limits de RPC/provider devnet
- `total_usd` incompleto si no existe valuacion confiable de todos los tokens

## Estrategia de testing

### Unit

- validacion de parametros de holdings y quote
- resolucion de mints por red
- normalizacion de balances SPL
- normalizacion de quote devnet

### Route

- `GET /api/wallet/balances` rechaza requests invalidos
- `GET /api/wallet/balances` devuelve SOL + SPL cuando existen
- `GET /api/quotes/usdc-sol` rechaza pares o amounts invalidos
- `GET /api/quotes/usdc-sol` devuelve quote normalizado
- `GET /api/quotes/usdc-sol` rechaza cualquier red distinta de `devnet`

### Chat integration

- el agente puede invocar `get_wallet_holdings` y `get_usdc_sol_quote`
- las herramientas no ejecutan transacciones ni preparan proposals
- las respuestas incluyen `network` y `updated_at`

### Regression

- el frontend sigue parseando `GetBalancesResponse`
- `front/src/lib/api/client.ts` y `front/src/lib/api/schemas.ts` quedan alineados con el backend
- la feature no depende de `GET /api/prices` mockeado

## Verificacion

- probar holdings para una wallet con SOL y al menos un token SPL
- probar wallet sin tokens SPL
- probar quote `USDC -> SOL` y `SOL -> USDC`
- probar errores por address invalido, network distinta de `devnet` y provider timeout
- verificar que ningun secreto de provider aparezca en payloads cliente o del agente

## Amendment 2026-05-13 — devUSDC pricing model

### Decisión técnica

`back/services/tools/orcaSwap.ts` debe separar dos conceptos:

1. **Mint de ejecución devnet:** `DEVNET_USDC_MINT` sigue siendo `BRjpCHty...` para construir quotes/tx contra el pool devnet.
2. **Precio de referencia:** devUSDC se fija en `1 USD`; no se consulta `/tokens/<DEVNET_USDC_MINT>` en Orca public API.

El servicio puede consultar SOL/USD desde Orca public API para `DEVNET_SOL_MINT`. Si esa consulta falla, puede usar `FALLBACK_SOL_USD_PRICE || 140` como fallback local de demo.

### Contrato extendido

`OrcaSwapQuote` y la respuesta normalizada `UsdcSolQuoteResult` agregan:

```ts
type QuoteSource = 'orca_token_api' | 'fallback_sol_usd';
quote_source: QuoteSource;
```

Reglas:

- `quote_source = 'orca_token_api'` cuando SOL/USD salió del provider.
- `quote_source = 'fallback_sol_usd'` cuando SOL/USD salió del fallback local.
- `route_context` debe mantenerse en `orca_usdc_sol_devnet` para identificar el par/ruta devnet.

### Testing adicional

- Unit test de `quoteOrcaUsdcToSol` debe mockear `fetch` y verificar que nunca se llama `/tokens/<DEVNET_USDC_MINT>`.
- Unit test de fallback debe verificar que, si falla SOL/USD, la quote usa `FALLBACK_SOL_USD_PRICE || 140` y marca `quote_source = 'fallback_sol_usd'`.
- Tests de `priceQuote` y schemas frontend deben aceptar y validar `quote_source`.

## Amendment 2026-05-13 — single quote source for UX and execution

### Decisión técnica

`quoteOrcaUsdcToSol` deja de estimar output con precio SOL/USD cuando puede consultar el pool. La fuente primaria pasa a ser `swapQuoteByInputToken` del Orca Whirlpool SDK contra `DEVNET_SOL_USDC_POOL`, igual que el flujo que construye la transacción real.

`QuoteSource` queda:

```ts
type QuoteSource = 'orca_whirlpool_quote' | 'fallback_sol_usd';
```

Reglas:

- `quote_source = 'orca_whirlpool_quote'` cuando el output viene de `swapQuoteByInputToken`.
- `quote_source = 'fallback_sol_usd'` solo si falla Whirlpool y `allow_fallback !== false`.
- El guard on-chain sigue comparando el precio implícito de la quote real del pool contra Pyth; puede rechazar si el pool devnet está desalineado.

### Testing adicional

- Unit test debe verificar que `quoteOrcaUsdcToSol` usa `swapQuoteByInputToken` y no `fetch`/token registry.
- API/schema/frontend deben aceptar `quote_source = 'orca_whirlpool_quote'`.
- Endpoint local debe mostrar output coherente con el pool real, aunque el guard pueda bloquear por desviación contra oráculo.

