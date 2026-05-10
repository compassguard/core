# Conditional Escrow Buy (SOL/USDC)

## Scope

This folder contains the Anchor program used by the feature `devnet-conditional-escrow-buy-sol`.
The program enforces all settlement constraints on-chain:

- User deposits `USDC_TEST_MINT` into a PDA escrow.
- Keeper/keeperless `execute_order` checks oracle freshness, confidence, price threshold and oracle account binding.
- Payout is sent from a system-owned `SOL_VAULT_PDA` and always executes on-chain with deterministic authority/signing.

## Required environment

Set these server-side variables before devnet bootstrap and runtime:

- `CONDITIONAL_ESCROW_BUY_PROGRAM_ID`
- `USDC_TEST_MINT`
- `USDC_TEST_DECIMALS` (commonly `6`)
- `TREASURY_USDC_ATA`
- `PYTH_SOL_USD_FEED`
- `SOLANA_RPC_URL`

Optional (keeper):

- `CONDITIONAL_ORDER_KEEPER_ENABLED=true|false`
- `CONDITIONAL_ORDER_KEEPER_KEYPAIR`
- `CONDITIONAL_ORDER_INDEX_INTERVAL_MS`
- `CONDITIONAL_ORDER_ORACLE_POLL_MS`
- `CONDITIONAL_ORDER_EXECUTE_BACKOFF_MS`

## Devnet bootstrap checklist

1. Fund your admin wallet with USDC (for testing deposits) and enough SOL for rent/transactions.
2. Create the vault config with:
   - `treasury_usdc_ata` set to the treasury destination
   - `usdc_test_mint`
   - `oracle_feed` (`PYTH_SOL_USD_FEED`)
   - oracle policy values (`max_oracle_age_seconds`, `max_confidence_bps`)
3. Fund the SOL vault PDA:
   - `SOL_VAULT = Pubkey::find_program_address(['sol-vault', vault_config], program)`
   - send SOL to it with normal System transfer.
4. Confirm:
   - `vault_config` account exists
   - `SOL_VAULT` has margin above the expected payout
   - oracle price account is current and not stale on devnet

## Operational notes

- Backend APIs:
  - `GET /api/conditional-orders?user=<wallet>`
  - `GET /api/conditional-orders/<orderPda>`
  - `POST /api/conditional-orders/<orderPda>` (triggers execution)
- `execute_order` must be permissionless from frontend/backend; the backend only proposes/observes and does not own user funds.
- The order instruction writes:
  - `user` and `order` lifecycle state
  - escrowed amounts
  - execution status, including `executed_*` fields

## Smoke test

1. Create a new conditional order from UI and sign `create_order_and_deposit`.
2. Confirm `getOrderDetail` lists the order as `open`.
3. Wait for oracle condition, or call POST trigger once it becomes executable.
4. Confirm funds moved:
   - treasury receives USDC
   - user receives SOL from vault
   - order status becomes `executed`.
