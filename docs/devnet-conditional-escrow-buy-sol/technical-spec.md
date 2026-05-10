# Technical Spec - Devnet Conditional Escrow Buy SOL

Version: 1
Status: Planned
Date: 2026-05-10
Feature: `devnet-conditional-escrow-buy-sol`

## Architecture Recommendation

Recomendación principal: crear un programa Anchor nuevo para escrow y settlement real, por ejemplo:

- `BACK/solana/conditional-escrow-buy/`

Tradeoff documentado:

- Extender `AgentActionGuard` reduce cantidad de programas y reutiliza algo de lógica oracle existente.
- Crear un programa dedicado separa approval metadata de custody logic, reduce riesgo de mezclar permisos y hace más auditable el settlement real.

Recomendación final:

- mantener `AgentActionGuard` como referencia histórica o capa de approvals si sigue siendo útil
- implementar escrow, vault authority, lifecycle y settlement en un programa dedicado `conditional-escrow-buy`

Motivo: la feature ya no es solo `executed=true`; ahora tiene custodia SPL, movimiento de lamports, treasury routing y reglas de lifecycle que merecen un modelo de cuentas propio.

## Current Repo Impact

Módulos probables a crear o modificar:

- `BACK/solana/conditional-escrow-buy/` o extensión equivalente dentro del workspace Anchor
- `BACK/solana/agent-action-guard/programs/agent-action-guard/src/lib.rs` solo si se decide compartir utilidades oracle o mantener compatibilidad
- `BACK/services/tools/conditionalBuySol.ts`
- `BACK/services/chat.ts`
- `BACK/services/onchainApproval.ts` o nuevo servicio on-chain específico de órdenes
- nuevas rutas API bajo `app/api/conditional-orders/...`
- `FRONT/src/types/api.ts`
- `FRONT/src/lib/api/schemas.ts`
- `FRONT/src/lib/api/client.ts`
- `FRONT/src/hooks/useWallet.ts`
- `FRONT/src/hooks/useAgentMessage.ts`
- `FRONT/src/components/chat/proposals/ConditionalBuyProposalCard.tsx`
- componentes nuevos de detalle/estado de orden si hace falta

## On-Chain Accounts

### Order PDA

Seeds sugeridas:

- `["order", user_pubkey, client_order_id]`

Campos:

- `user: Pubkey`
- `recipient: Pubkey`
- `client_order_id: u64 | [u8; 16]`
- `usdc_test_mint: Pubkey`
- `escrow_token_account: Pubkey`
- `treasury_usdc_ata: Pubkey`
- `sol_vault_pda: Pubkey`
- `oracle_feed: Pubkey`
- `desired_sol_lamports: u64`
- `max_usdc_in: u64`
- `target_price_usd_e8: u64`
- `max_oracle_age_seconds: u32`
- `max_confidence_bps: u16`
- `escrowed_usdc_amount: u64`
- `executed_usdc_amount: u64`
- `executed_sol_lamports: u64`
- `created_at: i64`
- `expires_at: i64`
- `status: u8`
- `bump: u8`

### Escrow Authority PDA

Seeds sugeridas:

- `["escrow-authority", order_pda]`

Responsabilidad:

- authority del token account escrow

### Escrow Token Account

Implementación recomendada:

- usar la ATA de `USDC_TEST_MINT` cuyo owner/authority es `ESCROW_AUTHORITY_PDA`
- derivarla con Associated Token Program, no con una cuenta token ad hoc si no hace falta

Propiedades:

- mint = `USDC_TEST_MINT`
- authority = `ESCROW_AUTHORITY_PDA`
- address = associated token account derivada de `(ESCROW_AUTHORITY_PDA, USDC_TEST_MINT)`

### SOL Vault PDA

Seeds sugeridas:

- `["sol-vault", vault_config_pubkey]`

Propiedades:

- system-owned account en una dirección PDA sin data propia
- controlado por el programa únicamente mediante `invoke_signed` con las seeds del PDA
- prefundeado off-chain por operador devnet
- `SOL_VAULT_PDA` puede exponerse como env/config para el backend, pero el programa siempre lo rederiva y valida por seeds

### Vault Config PDA

Seeds sugeridas:

- `["vault-config"]`

Campos:

- `admin`
- `treasury_usdc_ata`
- `usdc_test_mint`
- `usdc_decimals`
- `oracle_feed`
- `sol_vault_bump`
- `paused`

## On-Chain Instructions

### `initialize_vault_config`

Uso:

- bootstrap devnet

Valida/define:

- admin
- `USDC_TEST_MINT`
- `TREASURY_USDC_ATA`
- default `PYTH_SOL_USD_FEED`
- `usdc_decimals`, validado contra la mint cuando se inicializa

### `fund_sol_vault`

Uso:

- prefundear SOL vault desde signer admin/operator

Notas:

- recomendado: transferencia normal de lamports hacia la address derivada `SOL_VAULT_PDA`
- el vault no debe tener instrucciones de withdraw genéricas en el MVP; solo `execute_order` puede pagar al recipient bajo reglas de orden

### `create_order`

Uso:

- crear estado de orden

Inputs:

- `desired_sol_lamports`
- `max_usdc_in`
- `target_price_usd_e8`
- `recipient`
- `expires_at`
- overrides opcionales de oracle risk params

Validaciones:

- `desired_sol_lamports > 0`
- `max_usdc_in > 0`
- `target_price_usd_e8 > 0`
- `expires_at > now`
- mint y accounts canónicas

### `deposit_escrow`

Uso:

- mover `USDC_TEST` desde ATA del usuario a la token account escrow controlada por PDA

Recomendación:

- exponerlo junto con `create_order` como flujo combinado `create_order_and_deposit` para reducir fallas parciales de UX

Validaciones:

- signer = user
- monto = `max_usdc_in` o `deposit_amount` explícito
- mint correcto
- token account de origen = ATA de `user` para `USDC_TEST_MINT` o una cuenta token del usuario validada por owner/mint
- token account escrow = ATA derivada de `ESCROW_AUTHORITY_PDA` y `USDC_TEST_MINT`

### `create_order_and_deposit`

Recomendación MVP:

- instrucción principal de creación

Motivo:

- evita orden creada sin fondos
- simplifica approve flow del frontend

### `cancel_order`

Uso:

- user cancela antes de ejecución o antes de expiry, según política

Validaciones:

- signer = user
- estado = `Open`
- no ejecutada

Efectos:

- refund de escrow a ATA del usuario
- cierre o marcado `Cancelled`

### `execute_order`

Caller:

- permissionless actor; el keeper/backend es el caller operativo recomendado, pero no tiene privilegios especiales

Validaciones obligatorias:

- orden `Open`
- `now <= expires_at`
- `oracle_feed == expected`
- oracle no stale
- confidence `<= max_confidence_bps`
- precio `<= target_price_usd_e8`
- `required_usdc` calculado on-chain
- `required_usdc <= max_usdc_in`
- `required_usdc <= escrowed_usdc_amount`
- `sol_vault_lamports >= desired_sol_lamports + rent_floor`
- `treasury_usdc_ata` coincide con config y tiene mint `USDC_TEST_MINT`
- `escrow_token_account` coincide con la ATA esperada de `ESCROW_AUTHORITY_PDA`

Efectos atómicos:

- transferir `required_usdc` desde escrow a `TREASURY_USDC_ATA`
- transferir `desired_sol_lamports` desde `SOL_VAULT_PDA` a `recipient`
- devolver remanente USDC al usuario en la misma ejecución
- marcar `Executed`
- persistir importes ejecutados

### `expire_reclaim`

Uso:

- recuperar fondos luego de `expires_at`

Validaciones:

- orden no ejecutada
- `now > expires_at`
- caller autorizado; recomendado `user` o permissionless con refund al user

### `close_order`

Opcional post-MVP:

- cerrar cuentas vacías y recuperar rent

## Token and SOL Transfer Mechanics

SPL side:

- `token::transfer_checked` desde ATA user a escrow en depósito
- `token::transfer_checked` desde escrow a treasury en ejecución
- `token::transfer_checked` desde escrow a user ATA en cancelación/refund

SOL side:

- el vault recomendado es un system-owned PDA sin data propia
- el programa usa `invoke_signed` con las seeds de `SOL_VAULT_PDA` para hacer `system_instruction::transfer`
- como el vault no guarda data, el estado administrativo vive en `VaultConfig`
- la implementación debe validar un saldo mínimo operativo antes de transferir para no dejar el vault inutilizable

Atomicidad:

- `execute_order` debe hacer ambos movimientos o revertir completo

## Oracle Validation and Math

Feed esperado:

- placeholder `PYTH_SOL_USD_FEED`

Validaciones:

- account key exacta
- status/trading válido
- publish time dentro de `max_oracle_age_seconds`
- confidence relativa `<= max_confidence_bps`

Normalización:

- convertir precio a `usd_e8`
- usar `u128` para multiplicación/división
- checked math obligatorio

Fórmula sugerida:

```txt
required_usdc_atomic =
  ceil(desired_sol_lamports * oracle_price_usd_e8 * 10^usdc_decimals
       / (LAMPORTS_PER_SOL * 10^8))
```

Supuestos MVP:

- `USDC_TEST` probablemente usa 6 decimales; no hardcodear sin config/verificación
- guardar `usdc_decimals` en `VaultConfig` y validar que coincide con la mint

Checks:

- `required_usdc_atomic > 0`
- `required_usdc_atomic <= max_usdc_in`
- no overflow en conversiones
- rounding: usar ceil para no subcobrar `USDC_TEST` al treasury

## Backend / Keeper Architecture

El backend no decide ejecución. Solo observa y dispara.

Componentes:

- order registry reader: consulta órdenes `Open`
- oracle watcher: detecta candidatas por precio observado
- execution trigger: arma y envía `execute_order` como caller permissionless
- API/status layer: expone estado de órdenes para frontend

Comportamiento:

- keeper puede firmar solo su tx de trigger
- no necesita claves del usuario
- no tiene permisos on-chain especiales sobre órdenes o vaults
- si el programa rechaza, el backend solo registra el error

### Order discovery and polling cadence

MVP recomendado: polling server-side simple sobre cuentas del programa.

- Cada `Order` on-chain incluye `user`, `recipient`, `status`, `expires_at`, `target_price_usd_e8` y `created_at`.
- El backend lee órdenes con `getProgramAccounts` filtrando por discriminator de `Order`.
- Para vistas por usuario, filtra por el campo `user` del account data. Si el layout Anchor lo permite, usar `memcmp` por offset; si no, hacer decode completo y filtrar en memoria para MVP.
- Mantener un índice cacheado en memoria o storage liviano con TTL corto para no golpear RPC en cada render.

Cadencias sugeridas para demo:

- `order-indexer`: cada 15 segundos refresca cuentas `Open`, `Executed`, `Cancelled` y `Expired` recientes.
- `oracle-watcher`: cada 10 segundos consulta precio observado off-chain solo para identificar candidatas.
- `execution-trigger`: cada 10 segundos intenta ejecutar órdenes `Open` que parezcan cumplir condición según precio observado, con backoff por orden tras errores repetidos.
- `user-status-refresh`: frontend refetch cada 15-30 segundos mientras haya órdenes abiertas.

Regla de verdad:

- La cadencia off-chain solo afecta cuándo se intenta ejecutar o cuándo se actualiza UI.
- Aunque el backend crea que una orden es ejecutable, `execute_order` puede fallar si el programa ve precio stale, confidence alta, feed incorrecto, vault sin liquidez o estado inválido.
- La UI debe mostrar `observed_executable` como estado derivado del backend y `status` como estado confirmado por la cuenta on-chain.

Para producción o una demo con más carga, reemplazar polling por una combinación de:

- `programSubscribe` o logs websocket para cambios de cuenta.
- indexer persistente por `order_pda`, `user`, `status`, `expires_at`.
- cola de ejecución con backoff por orden.

### Per-user order lookup

El usuario se identifica por la wallet conectada con Phantom injected.

Flujo de consulta:

1. Frontend llama `GET /api/conditional-orders?user=<wallet_pubkey>`.
2. Backend valida que `user` sea una public key válida.
3. Backend obtiene órdenes desde cache/indexer o RPC.
4. Backend devuelve solo órdenes cuyo `Order.user == wallet_pubkey`.
5. Cada orden incluye `order_pda`, `status`, `escrow_token_account`, `desired_sol_lamports`, `max_usdc_in`, `executed_usdc_amount`, `executed_sol_lamports`, `expires_at`, `last_observed_price_usd`, `observed_executable` y `last_execution_error`.

No se requiere autenticación adicional para leer órdenes públicas de devnet en el MVP, porque los datos on-chain ya son públicos. Para acciones mutantes, la autorización vuelve al programa:

- crear/cancelar/reclamar requiere firma del usuario cuando corresponda
- ejecutar es permissionless en el MVP; el backend puede exponer un endpoint protegido para operación manual, pero esa protección no reemplaza las reglas on-chain
- ninguna API backend puede cambiar estado sin una transacción aceptada por el programa

Endpoints/API sugeridos:

- `POST /api/chat` sigue generando proposal y create/deposit approve flow
- `GET /api/conditional-orders?user=<pubkey>`
- `GET /api/conditional-orders/:orderPda`
- `POST /api/conditional-orders/:orderPda/execute` opcional para operador manual/keeper; protegido a nivel API para evitar spam, pero la instrucción on-chain sigue siendo permissionless

## Frontend Contract and UX

Proposal contract sugerido:

```ts
type ConditionalEscrowBuyParams = {
  input_token: 'USDC_TEST';
  desired_sol_lamports: string;
  desired_sol_ui: number;
  target_price_usd: number;
  target_price_usd_e8: string;
  max_usdc_in_ui: number;
  max_usdc_in_atomic: string;
  recipient: string;
  expires_at: string;
};
```

Approve response:

- `create_order_and_deposit` devuelve unsigned transaction para Phantom
- incluye `order_pda`, `escrow_token_account`, network y blockhash metadata

Frontend responsibilities:

- usar Phantom injected y no embedded
- deserializar y enviar tx preparada
- mostrar estado local `awaiting_signature`, `submitted`, `confirmed`, `failed`
- listar órdenes existentes con polling o refetch manual
- diferenciar errores de wallet, depósito y ejecución observada

UI guidance:

- usar layout sobrio y cartesiano
- cards para `Order`, `Escrow`, `Oracle`, `Vault`, `Execution`
- nada de hero marketing ni copy ambiguo tipo "swap"
- si el chat usa "swap" por lenguaje natural del usuario, la UI debe mostrarlo como "devnet escrow settlement", no como Jupiter/DEX execution

## Env and Config Placeholders

- `SOLANA_RPC_URL`
- `SOLANA_CLUSTER=devnet`
- `CONDITIONAL_ESCROW_BUY_PROGRAM_ID`
- `USDC_TEST_MINT`
- `TREASURY_USDC_ATA`
- `SOL_VAULT_PDA`
- `PYTH_SOL_USD_FEED`
- `KEEPER_PRIVATE_KEY` o mecanismo equivalente para operador devnet
- `MAX_ORACLE_AGE_SECONDS`
- `MAX_ORACLE_CONFIDENCE_BPS`

## Security Risks

- mezcla de concerns si se extiende demasiado `AgentActionGuard`
- sustitución de oracle account
- sustitución de token accounts o treasury ATA
- staleness/confidence mal calibrados
- bugs de math y redondeo
- vault SOL sin liquidez suficiente
- remanentes USDC retenidos si no se define reclaim claro
- autorización incorrecta en cancel/execute/expire
- treasury/mint mal configurados en devnet

## Verification Strategy

Unit tests:

- math de `required_usdc`
- conversiones e8/lamports/USDC decimals
- validaciones de estado
- rechazo por oracle stale/confidence/feed mismatch

Program tests:

- create + deposit exitoso
- cancel con refund completo
- execute success con price <= target
- execute fail con price > target
- execute fail con escrow insuficiente
- execute fail con vault SOL insuficiente
- expire + reclaim

Backend tests:

- keeper no marca success si la tx falla
- APIs de listado/detalle parsean estado real

Frontend tests:

- proposal render
- approve con unsigned tx
- estados Phantom
- detalle de orden y errores visibles

Devnet validation:

- bootstrap de mint/accounts placeholder
- fondeo de SOL vault
- flujo end-to-end con Phantom injected

## Rollback

- feature flag para ocultar el flujo real de escrow
- mantener `conditional_buy_sol` actual simulado sin mezclar estados
- no migrar usuarios existentes; las órdenes nuevas usan el programa nuevo
- si el programa falla en devnet, deshabilitar create/execute desde backend/frontend sin romper otras acciones
