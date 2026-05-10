# Functional Spec - Transaction History With Umbra Compatibility

Version: 1
Status: Planned
Date: 2026-05-09
Source: user request + explorer handoff + verified Umbra context

## Alcance

Definir el feature de historial de transacciones para la wallet del usuario dentro de la app, con una separacion explicita entre:

- historial publico visible on-chain
- historial privado o shielded asociado a Umbra, visible solo bajo consentimiento y datos autorizados

Esta spec cubre el alcance de producto, criterios de aceptacion y fases de entrega.

Incluye:

- historial publico reciente por wallet
- paginacion por cursor
- normalizacion a `TxHistoryItem`
- estados de UI para loading, empty, error y cargar mas
- copy y guardrails de privacidad para compatibilidad futura con Umbra

No incluye:

- integracion completa del SDK de Umbra
- decryption silenciosa de actividad privada
- mostrar counterparties o montos privados en el historial generico
- analytics avanzados, filtros complejos o busqueda full-text

## Respuesta a la compatibilidad con Umbra

Si, historial de transacciones y privacidad con Umbra son compatibles si el producto trata ambas cosas como dominios de visibilidad separados.

- El historial publico muestra solo acciones visibles en cadena para cualquier observador: firmas, timestamps, estados, y resumenes derivados de datos publicos.
- La actividad privada de Umbra debe mostrarse solo cuando el usuario autoriza usar datos locales, decryption, viewing grants o datos de compliance-granted access.
- El historial generico no debe filtrar automaticamente montos privados, counterparties privadas ni metadata sensible proveniente de Umbra.

## Objetivos

- Reemplazar el mock actual de historial por datos reales recientes de la wallet conectada.
- Mantener el contrato existente del frontend para `transactions` y `next_cursor`.
- Entregar un Phase 1 feasible para demo_fast sin bloquearse por la integracion de Umbra.
- Dejar definidos los guardrails funcionales para un futuro Phase 2 con historial privado.

## Actores

### Usuario

- conecta wallet
- abre la tab `History`
- consulta movimientos recientes
- entiende que el historial actual es publico
- en el futuro decide si habilita o no visibilidad privada de Umbra

### Backend

- consulta proveedor/RPC para obtener actividad publica
- normaliza resultados a un formato consistente
- aplica guardrails de respuesta y errores
- no revela datos privados de Umbra por defecto

### Frontend

- pide historial solo cuando la tab `History` esta activa
- muestra lista paginada, empty state, loading y errores
- muestra copy clara sobre el limite entre historial publico y privado

### Umbra future integration

- aporta estados privados como deposit, withdraw, claim o registration solo cuando el usuario autoriza ese dominio
- nunca mezcla datos privados en la vista publica sin consentimiento explicito

## Fases

## Phase 1 - Historial publico

El producto debe mostrar historial publico reciente de una wallet usando backend provider/RPC y normalizacion a `TxHistoryItem`.

Comportamiento esperado:

1. Usuario entra a `History`.
2. Frontend consulta `/api/wallet/transactions?address=<wallet>&limit=<n>&before=<cursor?>`.
3. Backend devuelve transacciones publicas recientes y `next_cursor` cuando haya mas paginas.
4. UI muestra resumen, timestamp, estado, monto neto publico cuando este disponible y acceso a explorer.
5. UI aclara que las transacciones privadas de Umbra no aparecen aun en esta vista publica.

## Phase 2 - Historial Umbra-aware

El producto puede sumar una vista o seccion separada para actividad privada de Umbra, con consentimiento explicito del usuario.

Capacidades futuras previstas:

- estado de registro Umbra
- eventos privados de deposit, withdraw y claim
- activity feed con datos desencriptados solo localmente o con grants vigentes
- viewing grants opcionales para compliance o soporte autorizado
- separacion visual clara entre actividad publica y actividad privada

## Casos de uso

### CU1 - Ver historial publico reciente

Como usuario con wallet conectada, quiero ver mis transacciones publicas recientes para entender que operaciones fueron visibles on-chain.

### CU2 - Continuar historial con paginacion

Como usuario, quiero cargar mas resultados para revisar actividad mas antigua sin recargar toda la app.

### CU3 - Entender el limite de privacidad

Como usuario, quiero una aclaracion visible de que el historial actual refleja actividad publica y que la actividad privada de Umbra requerira una integracion y consentimiento especificos.

### CU4 - Mantener compatibilidad futura con Umbra

Como producto, quiero que el diseño del historial no obligue a mezclar datos publicos y privados en el mismo resumen generico.

## Reglas funcionales

- El historial de Phase 1 es publico por definicion.
- La ausencia de Umbra no bloquea mostrar historial publico.
- Ningun dato privado de Umbra debe aparecer por inferencia, fallback o enrichment automatico.
- Si en el futuro existe actividad Umbra, debe mostrarse bajo un dominio separado o claramente rotulado como privado.
- No debe haber decryption silenciosa ni viewing grants implicitos.
- La UI debe tolerar respuestas vacias, fallos del proveedor y cursores agotados.

## Criterios de aceptacion

- La spec documenta que historial publico y privacidad Umbra son compatibles solo si se separan como dominios de visibilidad distintos.
- Phase 1 reemplaza el mock actual por historial publico real de la wallet conectada.
- El endpoint de historial acepta `address`, `limit` y `before`, y puede devolver `next_cursor`.
- Las respuestas de Phase 1 se normalizan al contrato existente `TxHistoryItem`.
- La UI muestra el monto neto publico de SOL cuando el backend puede calcularlo, y tolera transacciones sin monto disponible.
- La UI de History maneja loading, empty, error y paginacion/cargar mas.
- La UI muestra copy explicita indicando que las transacciones privadas requieren integracion Umbra posterior.
- La implementacion de Phase 1 no requiere instalar Umbra SDK si no hay una necesidad tecnica demostrada.
- El diseño futuro de Phase 2 exige consentimiento explicito, estado de registro Umbra, estados de deposit/withdraw/claim y ausencia de decryption silenciosa.
