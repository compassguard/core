# Functional Spec - Wallet Balance Display

Version: 1
Status: Planned
Date: 2026-05-09

## Alcance

Mostrar balances de la wallet conectada usando la wallet externa que ya conecta el usuario, sin embedded wallet.

Incluye:

- balance general de la wallet
- saldo disponible de SOL
- saldo disponible de USDC
- estados de loading, error y empty
- render compacto en desktop y mobile

No incluye:

- crear una wallet embedded
- ejecutar transacciones
- firmar mensajes
- soporte multired visible al usuario

## Decisiones funcionales

- La wallet soportada para esta feature es Phantom injected provider (`window.phantom.solana`).
- El login de la app y la wallet conectada son conceptos separados.
- Para leer balances alcanza con la `publicKey` de la wallet conectada.
- El balance general se muestra usando `total_usd` del backend.
- SOL y USDC se muestran como saldos destacados y se identifican por mint canonico.
- La red canonica de esta entrega es `mainnet-beta`.

Mints canonicos:

- SOL: `So11111111111111111111111111111111111111112`
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Experiencia esperada

Desktop:

- `TopBar` muestra el balance general como dato principal.
- `TopBar` muestra chips compactos de SOL y USDC cuando existan.
- `RightPanel` mantiene `BalanceCard` como resumen persistente.
- `AssetList` mantiene el detalle completo de activos.

Mobile:

- `MobileShell` muestra `BalanceCard` en el primer viewport del tab principal.
- El tab de assets permite ver el detalle, con SOL y USDC faciles de encontrar.
- El layout no debe saltar entre loading, success y error.

## Estados

Loading:

- No mostrar `0` como balance definitivo mientras se carga.
- Usar placeholder estable en `TopBar` y skeleton compacto en `BalanceCard`.

Success:

- Mostrar `total_usd`.
- Mostrar `ui_amount` de SOL.
- Mostrar `ui_amount` de USDC.
- Mostrar `updated_at` como referencia temporal.

Empty:

- Si `balances` viene vacio, mostrar total del backend y mensaje breve de ausencia de activos.
- Si faltan SOL o USDC pero hay otros tokens, no inventar saldos en cero.

Error:

- Mostrar error breve y accion de reintento en la superficie principal.
- `TopBar` degrada de forma neutra y no bloquea navegacion.

## Criterios de aceptacion

- La feature no depende de Phantom Embedded.
- El total general sale de `GET /api/wallet/balances?address=...`.
- SOL y USDC se identifican por mint, no por orden del array.
- `TopBar`, `BalanceCard` y `AssetList` quedan definidos como superficies del feature.
- Hay estados documentados de loading, error y empty.
- La UI se mantiene compacta y consistente con un producto de datos.
