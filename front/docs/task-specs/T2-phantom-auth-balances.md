# T2 Spec — Phantom injected auth + backend balances

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Agregar autenticación/display wallet con Phantom injected y balances desde backend.

## Scope

- `PhantomProvider` con Google como único provider y Solana como único address type.
- `ConnectButton` funcional.
- `useWallet` expone `isConnected`, `address`, `connect`, `disconnect`, `balances`.
- Balances vía `GET /api/wallet/balances`, no por RPC cliente.
- Settings permite export private key usando modal/flow del SDK.

## Acceptance

- El frontend nunca exporta métodos de signing.
- No hay wallet adapter legacy ni `sendTransaction`.
- Balances y assets se renderizan desde `/api/wallet/*`.
