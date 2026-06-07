# Functional Spec - Agent Quotes And Holdings

Version: 1
Status: Planned
Date: 2026-05-10
Source: user request + explorer handoff

## Alcance

Dar al agente acceso confiable a:

- la cotizacion entre USDC y SOL
- los tokens que tiene la wallet del usuario
- el monto disponible por token para esa wallet
- todo lo anterior funcionando sobre Solana `devnet`

La feature cubre tanto el contexto del agente como los contratos backend necesarios para que esa informacion exista de forma reusable en la app.

Incluye:

- lectura de holdings reales de wallet desde backend
- lectura de quote USDC/SOL desde backend compatible con `devnet`
- herramientas de solo lectura para el agente
- configuracion explicita de red `devnet` y mints de prueba
- timestamps y freshness explicitos
- errores claros cuando la data no pueda resolverse

No incluye:

- soporte `mainnet-beta`
- ejecucion de swaps o transferencias nuevas
- soporte arbitrario para cualquier par de tokens
- portfolio analytics avanzados
- enriquecimiento de precios genicos por symbol map mockeado
- exponer API keys o llamadas a providers desde frontend

## Objetivos

- Permitir que el agente responda con contexto real sobre cuanto SOL, USDC y otros tokens tiene el usuario.
- Permitir que el agente consulte una cotizacion actual entre USDC y SOL sin depender del endpoint mock de precios.
- Evitar alucinaciones de balances o precios cuando la data no este disponible.
- Reusar la arquitectura existente de `app/api/*` + `back/services/*`.

## No objetivos

- Resolver valuacion completa de portfolio en USD para todos los tokens.
- Diseñar un sistema general de market data para toda la app.
- Convertir al agente en ejecutor autonomo de operaciones.

## Actores

### Usuario

- conecta su wallet
- conversa con el agente
- espera respuestas sobre holdings y contexto de precio

### Agente

- consulta balances reales antes de sugerir acciones con fondos del usuario
- consulta quote USDC/SOL fresco antes de razonar sobre swaps o compras
- comunica cuando la data esta vencida, incompleta o no disponible

### Backend

- obtiene holdings desde RPC/backend provider
- obtiene quote USDC/SOL desde un proveedor/servicio compatible con `devnet`
- normaliza respuestas para frontend y herramientas del agente

## Decisiones funcionales

- La red objetivo de esta feature es exclusivamente Solana `devnet`.
- La cotizacion solicitada para el agente es una quote USDC/SOL de `devnet`, no un precio de `mainnet-beta`.
- La implementacion debe priorizar el servicio devnet ya existente de Orca para USDC/SOL cuando este disponible; Jupiter puede quedar como referencia futura de mainnet, pero no es el contrato base de esta feature.
- Los holdings del usuario salen de una fuente backend/RPC, no del frontend ni del prompt del usuario.
- La feature debe operar siempre sobre `devnet` por request y devolver esa red explicitamente en la respuesta.
- Si los mints devnet configurados no son consistentes, la feature debe fallar con error explicito en lugar de mezclar datos.
- La data expuesta al agente debe incluir `updated_at` y una nocion de freshness/TTL verificable.

## Casos de uso

### CU1 - El agente consulta holdings antes de recomendar una accion

Como agente, quiero saber que tokens y cuanto tiene el usuario para no sugerir acciones inviables o inconsistentes con su wallet.

### CU2 - El agente consulta quote USDC/SOL antes de hablar de precio

Como agente, quiero obtener una cotizacion actual entre USDC y SOL para responder sobre compras, swaps o comparaciones simples con datos frescos.

### CU3 - El usuario pregunta "cuanto tengo"

Como usuario, quiero que el agente me diga que tokens tengo y los montos disponibles, usando data real de mi wallet conectada.

### CU4 - El usuario pregunta "cuanto SOL me daria X USDC"

Como usuario, quiero que el agente use una cotizacion real y reciente para responder una pregunta de conversion USDC/SOL.

## Flujos

### Flujo de holdings

1. El usuario envia un mensaje con `user_address` disponible en la sesion.
2. El agente invoca una herramienta o contexto backend de holdings.
3. El backend consulta la wallet por SOL nativo y cuentas SPL relevantes.
4. El backend normaliza balances por token, omite cuentas cerradas y reporta `updated_at`.
5. El agente responde usando solo los balances devueltos.

### Flujo de quote

1. El usuario pregunta por precio, cotizacion o capacidad de compra entre USDC y SOL.
2. El agente invoca una herramienta o contexto backend de quote.
3. El backend consulta el servicio de quote devnet con los mints devnet configurados.
4. El backend devuelve quote normalizado, timestamp y parametros usados.
5. El agente responde aclarando que se trata de una cotizacion y no de una ejecucion.

## Necesidades de datos

### Holdings

- `user_address`
- `network: "devnet"`
- lista de balances por token con:
  - `symbol`
  - `mint`
  - `amount`
  - `decimals`
  - `ui_amount`
  - `usd_value` solo cuando exista una fuente confiable para ese campo
- `updated_at`

### Quote

- `network: "devnet"`
- `input_token`
- `output_token`
- `input_amount`
- `output_amount`
- `slippage_bps` cuando aplique
- `provider`
- `updated_at`

## Comportamiento ante errores

- Si falta `user_address`, el agente no debe inventar holdings y debe informar que no puede consultar la wallet.
- Si el backend no puede resolver SPL holdings, la respuesta debe indicar si solo hay balance nativo parcial o si la consulta fallo completa.
- Si el provider de quote devnet falla, el agente debe informar que no tiene una cotizacion fresca y evitar dar un precio como hecho.
- Si la request intenta usar una red distinta de `devnet`, debe fallar con error explicito de red no soportada.
- Si `devnet` no tiene mints configurados para SOL/USDC, la respuesta debe fallar con error explicito de configuracion.
- Si un token tiene decimals invalidos o datos no parseables, ese activo no debe exponerse con montos inventados.

## Criterios de aceptacion

- El agente dispone de una forma backend-managed de leer holdings reales de la wallet del usuario.
- El agente dispone de una forma backend-managed de leer una cotizacion USDC/SOL que funciona en `devnet`.
- La feature no usa el endpoint mock actual de `GET /api/prices` para responder precio al agente.
- Los holdings incluyen SOL nativo y holdings SPL del usuario, no solo SOL.
- Las respuestas incluyen `network: "devnet"` y `updated_at`.
- La feature falla de forma explicita ante red distinta de `devnet`, mint mismatch, timeouts o provider errors.
- No se exponen secretos de provider ni llamadas directas desde frontend.
- La spec deja claro que una cotizacion no equivale a una ejecucion garantizada.

## Amendment 2026-05-13 — devUSDC quote source on devnet

### Problema detectado

Durante prueba manual, el agente consultó `get_usdc_sol_quote` para estimar una compra inmediata de SOL con devUSDC y recibió:

```text
orca_quote_failed:orca_token_http_404:BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k:Token not found
```

El mint `BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k` es el devUSDC usado por el pool devnet, pero el token registry público de Orca no necesariamente indexa ese mint como token con precio consultable.

### Decisión funcional

- Para transacciones y pools devnet, la app debe seguir usando el mint devUSDC configurado.
- Para valorar devUSDC en una quote de UX, la app debe tratar devUSDC como stable demo token con precio `1 USD`.
- El servicio de quote no debe consultar el token registry de Orca para obtener precio de devUSDC.
- La fuente variable de precio es SOL/USD; si el provider de SOL falla, se permite fallback local explícito para demo.
- La respuesta debe indicar si la cotización vino de provider o de fallback para que el agente no la comunique como precio garantizado.

### Criterios de aceptación adicionales

- `get_usdc_sol_quote` no falla por 404 del token registry al pedir precio de devUSDC.
- `USDC -> SOL` y `SOL -> USDC` siguen usando los mints devnet correctos.
- La quote normalizada incluye metadata de fuente (`quote_source`) para diferenciar provider vs fallback.
- Los tests cubren que no se consulta precio de devUSDC en Orca token registry.

## Amendment 2026-05-13 — quote UX must match swap execution quote

### Problema detectado

La corrección anterior evitaba consultar precio de devUSDC en el token registry, pero seguía generando una cotización UX desde SOL/USD. En devnet, el pool Whirlpool puede estar muy desalineado contra Pyth/SOLUSD. Eso hacía que el agente comunicara una cantidad estimada y que, al preparar la transacción real, Orca cotizara otra cantidad.

### Decisión funcional

Para demo y para coherencia de producto, la cotización que ve/comunica el agente debe salir de la misma fuente que el swap real: la quote del Whirlpool devnet. El oráculo/guardrail sigue siendo una validación de seguridad separada y puede bloquear si el precio del pool se aleja demasiado del oráculo.

### Criterios de aceptación adicionales

- `get_usdc_sol_quote` usa la quote del Whirlpool devnet como fuente primaria.
- La propuesta de swap y el texto del agente no deben usar una fórmula SOL/USD si existe quote de Whirlpool.
- La respuesta mantiene `quote_source` y usa `orca_whirlpool_quote` para la fuente primaria.
- El fallback SOL/USD queda solo para degradación explícita cuando la quote de Whirlpool no está disponible.

