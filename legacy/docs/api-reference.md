# API reference

Esta es la referencia transversal de las rutas internas `app/api/*`. El frontend debe consumir estas rutas; no debe llamar providers externos ni manejar secrets.

## Lectura rápida

| Ruta | Método | Modo datos | Servicio dueño | Uso principal |
|---|---:|---|---|---|
| `/api/chat` | `POST` | live/mixed | `back/services/chat.ts` | Chat agentic, proposals, approvals, execution results e historial. |
| `/api/auth/dynamic/session` | `POST` | live/auth | `back/services/auth/*` | Convierte wallet Dynamic verificada en sesión propia httpOnly. |
| `/api/auth/session` | `GET` | live/auth | `back/services/auth/appSession.ts` | Devuelve identidad wallet autenticada de la sesión app-side. |
| `/api/auth/logout` | `POST` | live/auth | `back/services/auth/appSession.ts` | Limpia cookie de sesión app-side. |
| `/api/conditional-orders` | `GET`, `POST` | live/devnet | `back/services/conditionalOrders.ts` | Lista/refresca órdenes condicionales por wallet. |
| `/api/conditional-orders/[orderPda]` | `GET`, `POST` | live/devnet | `back/services/conditionalOrders.ts` | Detalle de orden y trigger manual de ejecución. |
| `/api/quotes/usdc-sol` | `GET` | live/devnet | `back/services/priceQuote.ts` | Quote devnet USDC/SOL vía Orca. |
| `/api/wallet/balances` | `GET` | live/devnet | `back/services/walletHoldings.ts` | Balances nativos/SPL normalizados. |
| `/api/wallet/transactions` | `GET` | live/provider | `back/services/transactionHistory.ts` | Historial de transacciones. |
| `/api/wallet/allocation` | `GET` | mock/demo | route local | Allocación de wallet para UI demo. |
| `/api/prices` | `GET` | mock/demo | route local | Precios mock para UI demo. |
| `/api/network/status` | `GET` | mock/demo | route local | Estado de red mock para UI demo. |
| `/api/jupiter/quote` | `GET` | live/proxy | `back/services/jupiter.ts` | Proxy de quote Jupiter. |
| `/api/birdeye/token-security` | `GET` | live/proxy | `back/services/birdeye.ts` | Seguridad/riesgo de token por mint. |
| `/api/risk-score` | `GET` | live/proxy | `back/services/riskScore.ts` | Score de riesgo de token. |
| `/api/helius/transactions` | `POST` | live/proxy | `back/services/helius.ts` | Proxy de transacciones Helius. |

## Convenciones

- **Boundary**: `front/src/lib/api/client.ts` es el cliente browser-facing. Las rutas `app/api/*` son el único borde permitido hacia backend/providers.
- **Secrets**: las API keys viven en server-side env vars; nunca en `front/` ni en variables `NEXT_PUBLIC_*` salvo datos explícitamente públicos.
- **Guardrails**: cualquier acción crítica debe pasar por `/api/chat` o por un route handler que delegue en `back/services/*` antes de pedir firma.
- **Errores**: los route handlers devuelven respuestas JSON estables cuando validan input o degradan providers. No dependas de mensajes internos de providers para UI.
- **Modo demo**: endpoints `mock/demo` existen para pintar UI. No los trates como datos productivos.

## Detalle por ruta

### `POST /api/chat`

Ruta central del agente. Maneja mensajes de usuario, propuestas, aprobación/rechazo, resultados de ejecución y persistencia de historial.

- Cliente: `front/src/lib/api/client.ts`
- Backend: `back/services/chat.ts`
- Contratos frontend: `front/src/types/api.ts`, `front/src/types/chat.ts`, `front/src/lib/api/schemas.ts`
- Guardrail: sí. Es el punto principal donde se decide si una acción se permite, se bloquea o requiere confirmación extra.

Payloads soportados por el cliente actual:

| Tipo | Uso |
|---|---|
| `user_message` | Enviar intención o pregunta del usuario. |
| `function_approve` | Aprobar una proposal pendiente. |
| `function_reject` | Rechazar una proposal pendiente. |
| `function_result` | Informar resultado de firma/ejecución al backend. |
| `get_history` | Recuperar contexto/historial de conversación. |

Cuando `DYNAMIC_ENVIRONMENT_ID`, `APP_SESSION_SECRET`, `REQUIRE_APP_SESSION=true` o producción están activos, `/api/chat` exige sesión app-side para acciones sensibles. `user_address` puede viajar como hint/compatibilidad, pero la identidad autorizada sale de la cookie httpOnly emitida por `/api/auth/dynamic/session`.

### `POST /api/auth/dynamic/session`

Crea una sesión propia de Compass vinculada a una wallet Dynamic activa.

- Cliente: `front/src/lib/api/client.ts#createDynamicAppSession`
- Backend: `back/services/auth/appSession.ts`, `back/services/auth/dynamic.ts`
- Cookie: `compass_app_session`, httpOnly, SameSite=Lax.
- Request: `dynamicUserId`, `walletAddress`, `walletType`, `walletProvider`, `dynamicAuthToken`.
- Validación: verifica JWT Dynamic por JWKS cuando hay Dynamic env/token; en desarrollo sin token usa modo `development` para smoke local.

### `GET /api/auth/session`

Devuelve la identidad wallet autenticada si la cookie app-side es válida. Responde `401 session_not_found` si no hay sesión o expiró.

### `POST /api/auth/logout`

Limpia la cookie app-side. El frontend lo llama al desconectar/cambiar wallet Dynamic.

### `GET /api/conditional-orders`

Lista órdenes condicionales asociadas a una wallet.

- Query principal: `user=<wallet>`
- Backend: `back/services/conditionalOrders.ts`
- Devnet-first: depende de contratos/devnet config documentados en `docs/onchain-deployments.md`.

### `POST /api/conditional-orders`

Refresca/indexa órdenes condicionales y devuelve snapshot observable.

- Backend: `back/services/conditionalOrders.ts`
- Uso esperado: polling/refresh backend-side, no bypass de guardrails para crear órdenes.

### `GET /api/conditional-orders/[orderPda]`

Devuelve detalle de una orden condicional por PDA.

- Param: `orderPda`
- Backend: `back/services/conditionalOrders.ts`

### `POST /api/conditional-orders/[orderPda]`

Trigger manual de ejecución de orden condicional si la condición y guardrails lo permiten.

- Param: `orderPda`
- Backend: `back/services/conditionalOrders.ts`
- Guardrail: sí; no debe usarse como ejecución directa sin validación.

### `GET /api/quotes/usdc-sol`

Quote de par devnet USDC/SOL.

- Query típica: `input_token`, `output_token`, `input_amount`, `slippage_bps`, `network`
- Backend: `back/services/priceQuote.ts`
- Modo: live/devnet, orientado a demo con Orca devnet.

### `GET /api/wallet/balances`

Consulta holdings de wallet.

- Query típica: `address`, `network`
- Backend: `back/services/walletHoldings.ts`
- Devuelve balances normalizados para UI y agente.

### `GET /api/wallet/transactions`

Consulta historial paginado de transacciones.

- Query típica: `address`, `limit`, `before`
- Backend: `back/services/transactionHistory.ts`
- Provider: Helius u otro adaptador configurado.

### Endpoints demo: `/api/prices`, `/api/network/status`, `/api/wallet/allocation`

Estos endpoints devuelven datos estáticos/demo para mantener la UI operativa.

- No son fuente de verdad productiva.
- Si se usan en decisiones de riesgo, primero migrarlos a servicios backend con provider real y tests.

### Proxies de providers: Jupiter, Birdeye, Risk Score, Helius

| Ruta | Query/body esperado | Nota |
|---|---|---|
| `/api/jupiter/quote` | Query de quote compatible con Jupiter | Proxy server-side. |
| `/api/birdeye/token-security` | `mint=<tokenMint>` | Usa API key server-side. |
| `/api/risk-score` | `mint=<tokenMint>` | Score externo/server-side. |
| `/api/helius/transactions` | Body JSON provider-specific | Mantener redacción de errores para no filtrar detalles internos. |

## Checklist para agregar una API nueva

- [ ] Crear route handler en `app/api/<feature>/route.ts`.
- [ ] Delegar lógica real a `back/services/*`.
- [ ] Validar input en el borde y devolver errores estables.
- [ ] Agregar tipos/schemas en `front/src/types/api.ts` y `front/src/lib/api/schemas.ts` si el frontend la consume.
- [ ] Agregar método en `front/src/lib/api/client.ts`.
- [ ] Documentar acá ruta, modo de datos, guardrail y servicio dueño.
- [ ] Agregar tests frontend/backend según corresponda.
