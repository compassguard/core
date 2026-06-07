# Documentación

Este directorio concentra documentación transversal y specs por feature. Si estás buscando cómo usar el repo, empezá por `README.md`; si estás cambiando comportamiento, buscá o creá la carpeta de feature correspondiente.

## Quick path

1. Entendé arquitectura y setup en `../README.md`.
2. Revisá APIs internas en `api-reference.md`.
3. Revisá workflow de desarrollo en `development-workflow.md`.
4. Para features, trabajá en `docs/<feature-kebab-case>/`.

## Convención de specs por feature

- Cada feature nueva debe vivir en `docs/<feature-kebab-case>/`.
- Una carpeta de feature debe usar estos archivos canónicos cuando aplique:
  - `functional-spec.md`
  - `technical-spec.md`
  - `task.json`
- La raíz de `docs/` queda reservada para documentación transversal, índices, decisiones históricas o artifacts legacy.

## Índice transversal

| Documento | Estado | Uso |
|---|---|---|
| `api-reference.md` | activo | Rutas `app/api/*`, modo de datos, servicio dueño y guardrail. |
| `development-workflow.md` | activo | Scripts, aliases, tests, lint y checklist de review. |
| `onchain-deployments.md` | activo | Direcciones devnet y workspaces Solana relacionados. |
| `architecture-design.md` | histórico | Diseño/arquitectura general previa; usar como contexto, no como contrato único. |
| `phantom-external-transaction-contracts.md` | activo/referencia | Contratos y flujo de transacciones externas con Phantom. |
| `token-risk-guard-backend.md` | referencia | Notas de guardrails/riesgo de token en backend. |
| `simulated-swap-safety-guard.md` | histórico | Documento histórico del guardrail de swap simulado. |
| `swap-guard-explainer.html` | referencia visual | Explainer HTML de arquitectura, guardrails, APIs, on-chain y keeper condicional. |
| `compass_artifact_*.md` | artifact histórico | Mantener como evidencia/contexto; no implementar desde ahí sin validar. |

## Specs por feature

| Feature | Carpeta |
|---|---|
| Agent action guard guarded transfer | `agent-action-guard-guarded-transfer/` |
| Agent quotes and holdings | `agent-quotes-and-holdings/` |
| Backend chat session history | `backend-chat-session-history/` |
| Chat session history | `chat-session-history/` |
| Conditional order DB keeper | `conditional-order-db-keeper/` |
| Devnet conditional escrow buy SOL | `devnet-conditional-escrow-buy-sol/` |
| Phantom direct connection | `phantom-direct-connection/` |
| Transaction history | `transaction-history/` |
| Transaction logic | `transaction-logic/` |
| Wallet balance display | `wallet-balance-display/` |
| Wallet linked chat history | `wallet-linked-chat-history/` |
| Wallet safety validation | `wallet-safety-validation/` |
| Wallet safety validation on-chain enforcement | `wallet-safety-validation-onchain-enforcement/` |

## Nota de mantenimiento

No agregues specs nuevas como `docs/functional-spec.md` o `docs/technical-spec.md` globales. Si una feature ya existe, continuá en su carpeta; si no existe, creá una carpeta nueva en kebab-case.

Al cambiar una API, actualizá `api-reference.md`. Al cambiar scripts/config/testing, actualizá `development-workflow.md`. Al cambiar contratos/direcciones devnet, actualizá `onchain-deployments.md`.
