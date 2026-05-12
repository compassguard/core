# On-chain deployments

Direcciones devnet usadas por la demo actual de guardrails Solana.

## Estado

- Red soportada para demo: `devnet`.
- No hay deployment mainnet configurado en este repo.
- Estas direcciones son dependencias de los flujos `AgentActionGuard`, wallet safety y conditional escrow.

## Direcciones devnet

| Nombre | Red | Dirección |
|---|---|---|
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

## Código relacionado

| Área | Path |
|---|---|
| AgentActionGuard Anchor workspace | `back/solana/agent-action-guard/` |
| ConditionalEscrowBuy Anchor workspace | `back/solana/conditional-escrow-buy/` |
| Backend conditional orders | `back/services/conditionalOrders.ts` |
| Conditional buy tool | `back/services/tools/conditionalBuySol.ts` |
| Wallet safety/on-chain checks | `back/services/walletSafetyValidation.ts`, `back/services/onchainApproval.ts` |
| Devnet bootstrap | `scripts/bootstrap-conditional-devnet.mjs` |

## Feature docs

- `docs/agent-action-guard-guarded-transfer/`
- `docs/wallet-safety-validation-onchain-enforcement/`
- `docs/devnet-conditional-escrow-buy-sol/`

## Checklist al cambiar una dirección

- [ ] Actualizar este archivo.
- [ ] Actualizar variables/env examples si aplica.
- [ ] Actualizar feature spec correspondiente en `docs/<feature>/`.
- [ ] Verificar tests backend que dependan de la config.
- [ ] Verificar que el frontend no hardcodee direcciones que deberían vivir en backend/config.
