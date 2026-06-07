# Technical Spec - Wallet Balance Display

Version: 1
Status: Planned
Date: 2026-05-09

## Arquitectura

La feature reutiliza la arquitectura existente:

- `useWallet` es la fuente cliente para `address`, `isConnected`, `balances`, `isBalancesLoading` y `balancesError`.
- `useWalletBalances(address)` consume `GET /api/wallet/balances?address=...`.
- `app/api/wallet/balances/route.ts` mantiene el contrato HTTP de balances.
- `TopBar`, `BalanceCard`, `AssetList`, `RightPanel` y `MobileShell` renderizan la informacion.

Flujo:

1. El usuario conecta Phantom injected.
2. `useWallet` obtiene la `publicKey`.
3. `useWalletBalances(address)` pide balances al backend.
4. React Query cachea la respuesta por address.
5. La UI consume el estado expuesto por `useWallet`.

## Contrato API

Request:

```http
GET /api/wallet/balances?address=<solana_public_key>
```

Respuesta minima:

```ts
type GetBalancesResponse = {
  balances: TokenBalance[];
  total_usd: number;
  updated_at: string;
  change_24h_pct?: number;
};

type TokenBalance = {
  symbol: string;
  mint: string;
  amount: string;
  decimals: number;
  ui_amount: number;
  usd_value: number;
  icon_url?: string;
};
```

Reglas:

- `address` es obligatorio.
- `total_usd` lo calcula el backend.
- `updated_at` debe ser ISO.
- El cliente no consulta precios ni RPC externos para completar balances.

## Seleccion de SOL y USDC

Agregar o reutilizar una derivacion deterministica:

```ts
type HighlightBalances = {
  sol?: TokenBalance;
  usdc?: TokenBalance;
};
```

Reglas:

- SOL se asigna solo por mint `So11111111111111111111111111111111111111112`.
- USDC se asigna solo por mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- No crear filas sinteticas.
- No asumir que los primeros tokens de `balances[]` son SOL y USDC.

## Responsabilidades UI

`TopBar`:

- muestra `total_usd` como balance general
- muestra chips compactos solo para SOL y USDC detectados
- usa placeholder estable durante loading

`BalanceCard`:

- muestra total, timestamp y estados
- soporta ausencia de `change_24h_pct`
- expone retry cuando hay error

`AssetList`:

- lista todos los activos disponibles
- mantiene empty state breve
- no duplica jerarquia visual del total

`RightPanel` y `MobileShell`:

- ubican las superficies sin recalcular datos
- mantienen layout estable en desktop y mobile

## Riesgos

- Drift documental hacia Phantom Embedded.
- Endpoint actual mockeado.
- Ambiguedad si se identifica por simbolo en vez de mint.
- Layout inestable si se muestra `0` durante loading.
- Cambio futuro de red sin redefinir mints.

## Verificacion

- Revisar que la feature use solo Phantom injected.
- Confirmar que `GetBalancesResponse` permita `change_24h_pct` opcional.
- Confirmar que SOL/USDC se seleccionen por mint.
- Probar estados loading, success, empty y error.
- Probar desktop y mobile.
