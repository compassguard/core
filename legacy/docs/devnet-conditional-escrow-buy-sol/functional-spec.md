# Functional Spec - Devnet Conditional Escrow Buy SOL

Version: 1
Status: Planned
Date: 2026-05-10
Feature: `devnet-conditional-escrow-buy-sol`

## Overview

Implementar una compra condicional real en devnet con settlement on-chain controlado por un programa de Solana.

Ejemplo objetivo:

- "compra 2 SOL cuando baje de 120 USDC"

La mecánica no usa Jupiter ni swap de mercado. Para evitar ambigüedad, en esta feature "swap" significa settlement controlado por el programa:

- el usuario deposita `USDC_TEST` en un escrow SPL administrado por PDA al crear la orden
- la orden guarda el target price y los límites de ejecución
- cuando el oracle cumple `SOL/USD <= target`, cualquier caller puede intentar ejecutar
- en la ejecución el programa mueve `USDC_TEST` del escrow a treasury y envía SOL desde un vault PDA prefundeado al usuario

El backend puede monitorear y disparar, pero no es la fuente de verdad. La validación final de condición, fondos y estado debe vivir on-chain.

## Goals

- Tener una orden condicional real con escrow de `USDC_TEST` y payout de SOL en devnet.
- Mantener self-custody: el usuario firma con Phantom injected la creación y el depósito inicial.
- Permitir ejecución posterior permissionless; el keeper/backend es solo el caller principal del demo, pero no tiene privilegios especiales para bypassear reglas.
- Hacer verificable en cadena el precio objetivo, el feed esperado, la frescura del oracle y los límites de la orden.
- Exponer un UX claro de estado de orden, fondos en escrow, liquidez del vault y resultado final.

## Non-Goals

- Integración con Jupiter, AMM o DEX real.
- Price discovery on-chain para comprar SOL en mercado abierto.
- Phantom Embedded.
- Mainnet deployment.
- Multi-oracle aggregation.
- Custodia backend de fondos del usuario o firma backend en nombre del usuario.

## Actores

- Usuario: crea, firma, cancela y reclama su orden.
- Programa Solana: fuente de verdad de la orden, escrow authority y vault authority.
- Keeper/backend: monitorea condición y envía `execute_order`, pero no decide el resultado.
- Treasury operator: prefundea el SOL vault y define treasury ATA para recibir `USDC_TEST`.
- Oracle account provider: feed devnet configurado para `SOL/USD`.

## Alcance funcional

Incluye:

- creación de orden con depósito real de `USDC_TEST`
- custodia SPL en una token account escrow controlada por authority PDA
- payout real de SOL desde vault PDA prefundeado
- validación on-chain de precio objetivo y seguridad del oracle
- cancelación y refund antes de ejecución
- expiración y reclaim definidos
- frontend de propuesta, firma, tracking y detalle de orden
- keeper/API para descubrir órdenes ejecutables y disparar la instrucción

No incluye:

- swap de mercado real
- matching engine
- recargas automáticas de liquidez fuera del vault configurado
- garantías de mejor precio que el target

## Real Settlement Mechanics

Orden natural:

- `desired_sol_lamports = 2 * LAMPORTS_PER_SOL`
- `target_price_usd_e8 = 120 * 10^8`
- `max_usdc_in` definido por usuario o derivado por frontend
- `recipient` por default = wallet del usuario

Mecánica exacta:

1. El frontend prepara una propuesta y muestra el resumen de orden.
2. El usuario firma con Phantom injected la creación de orden y el depósito de `USDC_TEST`.
3. El programa crea estado `Order` y usa una token account escrow de `USDC_TEST` cuya authority es un PDA del programa.
4. `USDC_TEST` se transfiere del ATA del usuario a la token account escrow en la misma operación lógica de creación/deposito.
5. La orden queda `Open`.
6. Un keeper o cualquier caller consulta órdenes abiertas.
7. Cuando el oracle on-chain cumple `price <= target`, se llama `execute_order`.
8. El programa recalcula el `required_usdc` en base a `desired_sol_lamports` y `oracle_price_e8`.
9. Si `required_usdc > max_usdc_in`, si el escrow no cubre el monto, o si el SOL vault no tiene lamports suficientes, la ejecución falla sin efectos parciales.
10. Si pasa todo, el programa transfiere `required_usdc` desde escrow a `TREASURY_USDC_ATA` y transfiere `desired_sol_lamports` desde `SOL_VAULT_PDA` a `recipient`.
11. La orden queda `Executed`.
12. Cualquier remanente de `USDC_TEST` en escrow se devuelve al usuario en la misma ejecución o mediante reclaim explícito, según la implementación elegida; la spec recomienda devolver el remanente en la misma ejecución para no dejar dust innecesario.

## Order Model

Campos funcionales mínimos:

- `order_id`
- `user`
- `recipient`
- `usdc_test_mint`
- `escrow_token_account`
- `escrow_authority_pda`
- `treasury_usdc_ata`
- `sol_vault_pda`
- `desired_sol_lamports`
- `max_usdc_in`
- `target_price_usd_e8`
- `oracle_feed`
- `max_oracle_age_seconds`
- `max_confidence_bps`
- `created_at`
- `expires_at`
- `status`
- `escrowed_usdc_amount`
- `executed_usdc_amount`
- `executed_sol_lamports`

## Estados

- `Draft`: propuesta mostrada en UI, todavía sin firma.
- `AwaitingSignature`: transacción de create/deposit preparada para Phantom.
- `Open`: orden creada y escrow fondeado.
- `Executable`: estado derivado off-chain para UI/keeper cuando parece cumplir condición, pero la fuente final sigue siendo on-chain.
- `Executing`: envío de `execute_order` en curso.
- `Executed`: payout de SOL y liquidación USDC completados.
- `Cancelled`: orden cancelada por usuario y escrow refundado.
- `Expired`: vencida; ya no puede ejecutar.
- `Reclaimed`: fondos recuperados post-expiry según regla final implementada.
- `FailedExecutionAttempt`: intento fallido por precio, staleness, liquidez o saldo; no cambia estado persistente salvo telemetría.

## User Flows

### 1. Crear orden

1. Usuario expresa intención en chat o UI estructurada.
2. Backend responde proposal con parámetros normalizados y modo de ejecución `phantom_sign_and_send`.
3. Frontend muestra cards sobrias de orden, escrow y condición.
4. Usuario confirma.
5. Frontend solicita unsigned transaction de `create_order + deposit`.
6. Usuario firma y envía con Phantom injected.
7. UI confirma `order_pda`, `escrow_token_account` y monto escrowed.

### 2. Cancelar antes de ejecución

1. Usuario abre orden `Open`.
2. Frontend solicita tx de `cancel_order`.
3. Programa valida owner, estado no ejecutado y reglas de expiración/cancelación.
4. Programa devuelve todo el `USDC_TEST` al usuario y cierra o marca la orden según implementación.

### 3. Ejecutar cuando condición se cumple

1. Keeper o cualquier caller detecta una orden candidata.
2. Llama `execute_order`.
3. Programa valida:
   - orden activa y no expirada
   - feed correcto
   - precio `<= target`
   - staleness/confidence
   - cálculo de `required_usdc`
   - `required_usdc <= max_usdc_in`
   - escrow suficiente
   - SOL vault con liquidez suficiente
4. Si todo pasa, liquida de forma atómica.
5. UI refleja `Executed` con cantidades reales y signatures.

### 4. Expirar y reclamar

1. Si `expires_at` pasó y la orden no se ejecutó, ya no puede liquidarse.
2. El usuario llama `expire_reclaim` o `cancel_order` bajo la regla final elegida.
3. El programa devuelve el escrow restante al usuario.

## Error Cases

- wallet Phantom ausente o desconectada
- unsigned transaction faltante o inválida
- `USDC_TEST` ATA del usuario sin balance suficiente
- allowance/cuenta incorrecta para depósito
- `oracle_feed_mismatch`
- `oracle_price_above_target`
- `oracle_data_stale`
- `oracle_confidence_too_high`
- overflow o unit conversion inválida
- `required_usdc > max_usdc_in`
- escrow insuficiente
- SOL vault sin liquidez suficiente
- orden ya ejecutada
- orden cancelada o expirada
- signer no autorizado para la acción
- treasury ATA o mint configurados incorrectamente

## UX Requirements

- Mantener una UI tipo data-product, no marketing hero.
- Mostrar cards claras para:
  - resumen de orden
  - estado del escrow
  - condición oracle
  - estado del SOL vault
  - historial de acciones
- Mostrar copy explícito de que no es un DEX swap sino un payout controlado por vault.
- Si se usa la palabra "swap" en UI/chat, acompañarla con "devnet escrow settlement" o copy equivalente para no prometer ejecución en mercado.
- Mostrar todos los importes en unidades humanas y base units cuando haga falta inspección.
- Diferenciar:
  - estado observado por backend/keeper
  - estado garantizado por programa on-chain

## Acceptance Criteria

- El usuario puede crear en devnet una orden real que custodia `USDC_TEST` en una token account escrow controlada por PDA.
- La creación/deposito se firma con Phantom injected; no hay backend signing del usuario.
- La ejecución solo puede completar si el programa on-chain valida feed esperado, `price <= target`, staleness, confidence y límites de la orden.
- La ejecución mueve `USDC_TEST` desde escrow a treasury y SOL desde `SOL_VAULT_PDA` al usuario en un settlement real, no simulado.
- Si el escrow no alcanza o el SOL vault no tiene liquidez suficiente, la instrucción falla sin transferencias parciales.
- El backend/keeper puede gatillar la ejecución, pero no puede forzarla si la validación del programa falla.
- El endpoint/manual trigger puede estar protegido operacionalmente, pero la instrucción on-chain `execute_order` no depende de confianza en el backend.
- El usuario puede cancelar o reclamar fondos en los estados permitidos.
- La UI muestra estados `AwaitingSignature`, `Open`, `Executing`, `Executed`, `Cancelled`, `Expired` y errores relevantes.
- La feature documenta placeholders de configuración para `USDC_TEST_MINT`, `TREASURY_USDC_ATA`, `SOL_VAULT_PDA` y `PYTH_SOL_USD_FEED`.
