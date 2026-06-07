# Functional Spec - Wallet Safety Validation On-Chain Enforcement

Version: 1
Status: Planned
Date: 2026-05-09
Feature: `wallet-safety-validation-onchain-enforcement`

## Objetivo

Extender la feature existente `wallet-safety-validation` para que una transferencia SOL aprobada por backend no pueda ejecutarse como `SystemProgram.transfer` directo, sino solo mediante una instrucción del programa `AgentActionGuard` que haga enforcement on-chain de:

- policy del usuario
- approval asociado al `action_hash`
- attestation de seguridad de la wallet destino
- expiración y anti-replay

El flujo sigue siendo self-custodial y `Phantom-first`: el backend prepara la transacción unsigned, el frontend la presenta, y el usuario firma/envía con Phantom. El backend no recibe `signed_tx_base64`.

## Alcance

Incluye:

- transferencias SOL de wallet a wallet ya cubiertas por la feature actual
- enforcement on-chain obligatorio para la ejecución final
- attestation dinámica de seguridad emitida por backend/oracle autorizado y verificable on-chain
- verificación determinística del PDA `ActionApproval` y del PDA de attestation
- actualización de contratos backend/frontend para exponer el nuevo flujo `guarded_transfer`
- estados UX para approval on-chain, firma Phantom y fallas de enforcement

No incluye:

- swaps
- SPL token transfers para este MVP
- reemplazar la lógica off-chain de scoring por scoring enteramente on-chain
- custody backend
- backend como firmante de la transferencia del usuario
- garantía absoluta de "reputación" on-chain sin attestation externa

## Contexto Base

Estado actual según handoff:

- `wallet-safety-validation` ya existe como feature separada y no debe sobrescribirse.
- El backend hoy valida off-chain/RPC, crea proposal y `function_approve` devuelve `unsigned_tx_base64`.
- El frontend firma/envía con Phantom.
- La transferencia simple actual no invoca un programa Solana propio.
- Existe `AgentActionGuard` con `UserPolicy` y `ActionApproval`.
- La verificación actual en `back/services/onchainApproval.ts` es débil porque mira logs/invocación pero no lee PDAs.

## Problema a Resolver

Hoy el backend puede preparar una transferencia directa luego de validaciones off-chain. Eso deja un bypass conceptual: la transacción que mueve fondos no prueba en cadena que:

- el `action_hash` aprobado coincide con la acción final
- la aprobación sigue activa
- la wallet destino pasó la validación de seguridad esperada para esa ejecución

El objetivo de esta extensión es que la operación crítica quede unida a cuentas verificables en cadena y que el backend solo pueda preparar una transacción ejecutable si esas cuentas existen y matchean.

## Actores

- Usuario: revisa y firma la transferencia con Phantom.
- Backend: hace análisis off-chain, genera proposal, crea o referencia attestation, y prepara la transacción unsigned.
- Programa `AgentActionGuard`: valida policy, approval, attestation y ejecuta la CPI al System Program.
- Frontend: muestra la decisión, solicita la firma y reporta `tx_signature` si hace falta continuidad de chat.
- Oracle/attestor autorizado: publica la attestation on-chain consumida por `guarded_transfer`.

## Flujo Funcional

### Flujo feliz

1. El usuario pide enviar SOL a una wallet.
2. El backend ejecuta validaciones off-chain existentes: formato, heurísticas, reputación, blocklists y policy.
3. Si la decisión es aprobable, el backend construye un `action_hash` canónico y asegura que exista:
   - `ActionApproval` PDA activo para esa acción
   - `WalletSafetyAttestation` PDA vigente para el destinatario y contexto de riesgo
4. El frontend muestra la propuesta con monto, destino, decisión y vencimiento.
5. El usuario confirma.
6. `function_approve` devuelve una unsigned transaction cuya instrucción principal es `guarded_transfer`.
7. Phantom firma y envía la transacción.
8. El programa valida `UserPolicy`, `ActionApproval`, `WalletSafetyAttestation`, signer, recipient, amount y expiración.
9. Si todo coincide, el programa hace CPI a `SystemProgram::transfer`.
10. La aprobación queda marcada como ejecutada y la UI muestra resultado confirmado.

### Rechazo

Si las validaciones off-chain resultan en bloqueo duro, no se crea proposal aprobable ni transacción para Phantom.

### Warning

Si el riesgo es advertencia pero la policy permite continuar, la UI debe mostrar razones y requerir confirmación explícita antes de pedir la tx unsigned.

### Expiración o revocación

Si el approval o la attestation expiraron entre la propuesta y la firma, la instrucción falla on-chain y la UI debe mostrar que la validación venció y que hace falta regenerar la propuesta.

## Estados de Decisión

- `REJECT`: no se devuelve transacción y Phantom no se abre.
- `ALLOW_WITH_CONFIRMATION`: se devuelve flujo aprobable normal.
- `WARN_WITH_CONFIRMATION`: se devuelve flujo aprobable con advertencias visibles.
- `EXPIRED`: proposal, approval o attestation ya no son válidos.
- `ONCHAIN_VERIFICATION_FAILED`: la transacción llegó a cadena pero el programa rechazó por mismatch, expiración o policy.
- `EXECUTED`: transferencia completada y approval marcado como usado.

## Impacto UX

- La propuesta debe dejar explícito que la transferencia está "protegida por guardrail on-chain".
- El usuario sigue firmando una sola vez en Phantom para la ejecución.
- La UI debe diferenciar:
  - riesgo evaluado off-chain
  - enforcement verificado on-chain
- El detalle de la propuesta debe poder mostrar:
  - `action_hash` resumido
  - expiry de approval
  - expiry de attestation
  - estado `awaiting_signature`, `submitted`, `confirmed`, `failed`
- Los mensajes de error deben distinguir:
  - validación de reputación fallida
  - approval inexistente o vencido
  - attestation inexistente o vencida
  - mismatch entre wallet conectada y wallet de la proposal

## Criterios de Aceptación

- Una transferencia SOL aprobada ya no se ejecuta mediante `SystemProgram.transfer` directo desde backend, sino mediante `AgentActionGuard.guarded_transfer`.
- `function_approve` devuelve una unsigned transaction apta para Phantom que referencia PDAs determinísticos de approval y attestation.
- El programa rechaza la transferencia si el `ActionApproval` no existe, está expirado, revocado, ejecutado o no coincide con el `action_hash` esperado.
- El programa rechaza la transferencia si la `WalletSafetyAttestation` no existe, no corresponde al destinatario/monto/contexto esperado o está expirada.
- El backend deja de considerar suficiente una prueba basada solo en logs o en la mera invocación del programa; la verificación posterior requiere lectura determinística del PDA de approval y, cuando aplique, del PDA de attestation.
- El frontend mantiene el modelo `Phantom-first`: el backend nunca recibe `signed_tx_base64`.
- La documentación deja explícitos los casos fuera de alcance del MVP, en particular SPL transfer y scoring íntegramente on-chain.
