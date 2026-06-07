# Functional Spec: Dynamic Wallet Auth

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-05-12
- **Estado:** Draft para revisión
- **Feature:** `dynamic-wallet-auth`

## Resumen

Migrar la capa de conexión/autenticación wallet-first desde Phantom directo hacia **Dynamic**, manteniendo la wallet como identidad operativa del producto. Dynamic debe permitir conectar wallets externas Solana, crear embedded wallets cuando el usuario no tenga wallet, exportar embedded wallets y operar transacciones sin saltarse los guardrails existentes.

## Objetivo

Permitir que un usuario use Compass sin crear una cuenta clásica propia de la plataforma:

- Si ya tiene wallet, conecta y verifica esa wallet con Dynamic.
- Si no tiene wallet, Dynamic crea una embedded wallet Solana.
- La app emite una sesión propia atada a la wallet activa verificada.
- El historial de chat y las acciones sensibles quedan scopeadas por wallet address.

## Principios funcionales

| Tema               | Decisión                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| Identidad primaria | La wallet address Solana activa es la identidad operativa.                     |
| Dynamic user       | Se usa como identidad/proveedor externo, no como fuente única del historial.   |
| App session        | La emite el backend propio después de validar Dynamic/wallet ownership.        |
| Historial          | Scope primario por wallet address. No se mezclan historiales entre addresses.  |
| Transacciones      | Siempre pasan por backend guardrails antes de pedir firma.                     |
| Export             | Las embedded wallets deben tener un escape hatch de export si está habilitado. |

## Alcance

### Incluido

- Integrar Dynamic como provider de autenticación/wallet en frontend.
- Soportar wallets externas Solana conectadas mediante Dynamic.
- Soportar embedded wallets Solana creadas por Dynamic.
- Exponer wallet activa y tipo de wallet al resto de la app.
- Reemplazar dependencias directas del flujo Phantom-only por una capa `useWallet` Dynamic-aware.
- Crear sesión propia de la app validada contra Dynamic/wallet activa.
- Enviar auth de app en requests al backend.
- Scopear historial visible por wallet activa.
- Permitir transferencias y acciones on-chain usando la wallet activa, después de guardrails.
- Permitir export de embedded wallet cuando Dynamic lo permita.
- Mantener bloqueo por wallet mismatch en propuestas, aprobaciones, rechazos y resultados.

### Fuera de alcance

- Crear un sistema de usuarios propio con email/password.
- Custodiar private keys en el backend propio.
- Mover fondos sin firma/consentimiento del usuario.
- Unificar historiales de múltiples wallets por defecto.
- Crear un workspace multi-wallet completo con vista agregada global.
- Migrar historiales antiguos a una base durable multi-dispositivo.
- Reemplazar los guardrails on-chain/backend existentes.
- Habilitar automatización offline/agentic sin una spec separada.

## Personas y casos de uso

### CU-1: Usuario con Phantom/Solflare existente

**Precondición:** El usuario ya tiene una wallet Solana compatible.

**Flujo:**

1. El usuario abre la app.
2. Hace clic en conectar wallet.
3. Dynamic muestra opciones de wallets Solana.
4. El usuario elige su wallet externa.
5. Dynamic conecta y verifica ownership.
6. La app recibe la wallet activa verificada.
7. El backend emite una sesión propia para esa wallet.
8. La app muestra el historial solo de esa wallet.

**Postcondición:** El usuario puede chatear y operar usando su wallet externa.

### CU-2: Usuario sin wallet

**Precondición:** El usuario no tiene wallet externa o no quiere usarla.

**Flujo:**

1. El usuario inicia sesión mediante el flujo Dynamic configurado.
2. Dynamic crea una embedded wallet Solana.
3. La app recibe la embedded wallet como wallet activa.
4. El backend emite una sesión propia para esa address.
5. La app muestra estado conectado y guía al usuario para fondear/usar la wallet.

**Postcondición:** El usuario tiene una wallet Solana usable desde la app.

### CU-3: Usuario transfiere fondos

**Precondición:** El usuario tiene wallet activa y fondos suficientes.

**Flujo:**

1. El usuario pide transferir fondos a otra wallet.
2. Backend evalúa intención, destino, monto, políticas y guardrails.
3. Si la acción es permitida o requiere confirmación, backend prepara una unsigned transaction canónica.
4. Frontend solicita firma/envío mediante la wallet activa Dynamic.
5. La wallet firma y envía la transacción.
6. Backend recibe `function_result` y actualiza estado/historial.

**Postcondición:** La transacción queda registrada y visible en la app.

### CU-4: Usuario exporta embedded wallet

**Precondición:** La wallet activa es embedded y Dynamic tiene export habilitado.

**Flujo:**

1. El usuario abre Settings/Wallet.
2. La app muestra opción “Export embedded wallet”.
3. El usuario confirma advertencias de seguridad.
4. Dynamic abre el flujo de reveal/export.
5. Solo el usuario ve la private key/credential exportable.
6. El usuario puede importarla en Phantom u otra wallet compatible.

**Postcondición:** El usuario puede usar la misma address fuera de la app.

### CU-5: Usuario cambia de address

**Precondición:** Usuario conectado con Wallet A.

**Flujo:**

1. El usuario cambia a Wallet B desde Dynamic o desde la wallet externa.
2. La app detecta cambio de wallet activa.
3. La app limpia estado runtime de Wallet A.
4. La app carga solo bootstrap/historial de Wallet B, si existe.
5. La app marca cualquier conversación de otra wallet como inaccesible o la oculta.

**Postcondición:** No hay leakage visual ni operativo entre wallets.

## Requisitos funcionales

### RF-1: Dynamic como provider wallet-first

- La app debe envolver la UI cliente con `DynamicContextProvider`.
- Debe habilitar conectores Solana.
- Debe usar el `environmentId` público de Dynamic desde variable `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`.
- Debe conservar el producto como wallet-first: el usuario no crea una cuenta clásica propia.

### RF-2: Wallet externa verificada

- El usuario debe poder conectar una wallet Solana externa.
- La app debe distinguir wallet conectada de wallet verificada.
- Las acciones sensibles requieren wallet verificada.
- Una wallet conectada sin verificar no debe habilitar historial durable ni aprobaciones sensibles.

### RF-3: Embedded wallet Solana

- La app debe permitir que Dynamic cree una embedded wallet Solana cuando el usuario no tenga wallet.
- La embedded wallet debe aparecer como wallet activa usable.
- La UI debe mostrar claramente si la wallet es `embedded` o `external`.

### RF-4: Sesión propia de la app

- Después de una autenticación/verificación Dynamic válida, el frontend debe obtener una sesión propia del backend.
- El backend no debe confiar únicamente en `user_address` enviado por el body.
- Requests sensibles deben incluir sesión app-side, preferentemente cookie httpOnly o header bearer según decisión técnica.
- La sesión debe estar vinculada a `dynamicUserId`, `walletAddress` y `walletType`.

### RF-5: Historial por wallet activa

- La lista visible de conversaciones debe filtrar por wallet activa.
- Cambiar de wallet no debe mostrar mensajes ni propuestas de otra address.
- Desconectar wallet debe limpiar el runtime activo.
- El backend debe rechazar acceso a sesiones cuyo `walletAddress` no coincide con la identidad autenticada.

### RF-6: Transacciones con wallet activa

- Toda transacción crítica debe pasar primero por guardrails backend/on-chain.
- El frontend solo puede firmar/enviar transacciones preparadas por backend.
- La firma debe ocurrir con la wallet activa de Dynamic.
- Si la wallet activa cambia antes o durante la firma, la acción debe fallar con `wallet_mismatch`.

### RF-7: Export de embedded wallet

- Si la wallet activa es embedded y export está habilitado en Dynamic, Settings debe exponer export.
- La app debe mostrar advertencias claras antes de abrir el flujo.
- La private key no debe tocar backend ni estado React propio.
- Si export está deshabilitado por configuración Dynamic, la UI debe ocultar la acción o explicar que no está disponible.

### RF-8: Link/unlink futuro sin mezclar por defecto

- Dynamic puede linkear múltiples wallets a un usuario.
- La app debe guardar `dynamicUserId` como metadato, pero no debe mezclar historiales por defecto.
- Cualquier vista multi-wallet agregada queda para una spec posterior.

## Reglas de seguridad

- Ninguna operación on-chain puede construirse desde intención cruda del usuario en frontend.
- El backend debe verificar que la sesión app-side autoriza la wallet solicitada.
- `user_address` del body solo puede usarse como hint/compatibilidad, no como prueba de identidad.
- Las propuestas pendientes deben guardar `expectedUserAddress`.
- Firma/envío debe validar `expectedUserAddress === activeWalletAddress` antes de llamar al signer.
- Export de private key debe delegarse exclusivamente al flujo Dynamic.
- Wallets no verificadas no pueden aprobar/rechazar propuestas ni reportar resultados.

## UX esperada

### Estado desconectado

- CTA principal: “Connect or create wallet”.
- Dynamic modal ofrece wallet externa y embedded wallet según configuración.

### Estado conectado

- Mostrar address truncada.
- Mostrar tipo: `External wallet` o `Embedded wallet`.
- Mostrar botón de disconnect/logout.
- Mostrar export solo para embedded wallets exportables.

### Estado wallet mismatch

- Mostrar mensaje claro: “Esta conversación pertenece a otra wallet”.
- Bloquear input/approve/reject.
- Ofrecer iniciar nueva conversación para wallet actual.

## Criterios de aceptación

- Usuario con Phantom puede conectarse vía Dynamic y operar con la misma address.
- Usuario sin wallet puede crear embedded wallet Solana vía Dynamic.
- Backend emite sesión propia vinculada a wallet activa verificada.
- `/api/chat` no acepta acciones sensibles solo por `user_address` sin sesión válida.
- Historial visible se filtra por wallet activa.
- Wallet switch no muestra conversaciones de la wallet previa.
- Transferencia a otra wallet usa tx preparada por backend y firmada por Dynamic wallet activa.
- Export de embedded wallet abre flujo Dynamic y no expone private key al código propio.
- Tests cubren wallet externa, embedded wallet, switch de wallet, mismatch y export unavailable.

## Riesgos y mitigaciones

| Riesgo                                | Impacto | Mitigación                                                         |
| ------------------------------------- | ------: | ------------------------------------------------------------------ |
| Vendor lock-in con Dynamic            |   Medio | Encapsular Dynamic detrás de `useWallet`/adapter propio.           |
| Mezcla de historiales entre addresses |    Alto | Filtrar UI y backend por wallet activa autenticada.                |
| Wallet conectada pero no verificada   |    Alto | Requerir verified wallet para sesión durable y acciones sensibles. |
| Cambio de wallet durante firma        |    Alto | Validar `expectedUserAddress` antes y después de sign/send.        |
| Export mal entendido por usuario      |   Medio | Warnings explícitos y delegar reveal a Dynamic.                    |
| Configuración dashboard incompleta    |   Medio | Checklist de env/dashboard y fallback UI claro.                    |
| Lint/tests preexistentes fallan       |   Medio | Ejecutar suites focalizadas y documentar fallas no relacionadas.   |

## Métricas de éxito

- 0 leakage visual entre wallets en QA manual.
- 100% de acciones sensibles incluyen sesión app-side validada.
- Usuario puede completar connect external wallet → chat → proposal → sign/send.
- Usuario puede completar embedded wallet creation → fund/transfer/export path en smoke test.

## Referencias

- Dynamic React SDK: `@dynamic-labs/sdk-react-core`
- Dynamic Solana connector: `@dynamic-labs/solana`
- Dynamic embedded wallets MPC setup
- Dynamic Solana signing/sending transactions
- Dynamic importing/exporting embedded wallets
- Docs existentes relacionadas:
  - `docs/wallet-linked-chat-history/`
  - `docs/phantom-direct-connection/`
  - `front/docs/frontend-spec.md`
