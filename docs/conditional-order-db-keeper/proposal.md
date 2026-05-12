# Proposal - Conditional Order DB Keeper

Version: 1
Status: Proposed
Date: 2026-05-12
Feature: `conditional-order-db-keeper`

## Resumen ejecutivo

Migrar el monitoreo de órdenes condicionales desde un indexer en memoria con `setInterval` hacia una arquitectura persistente basada en DB + cron/worker.

La idea es que cada orden condicional tenga un registro off-chain persistente en DB que funcione como una cola operacional. Un cron o worker periódico toma órdenes pendientes, refresca estado on-chain y oráculo, evalúa si la condición se cumple y, si corresponde, dispara `execute_order` contra el programa Solana.

La DB no reemplaza a Solana como fuente de verdad. La DB acelera, ordena, reintenta y observa. El smart contract sigue siendo quien valida finalmente si una orden puede ejecutarse.

```txt
Solana order account = fuente de verdad
DB table            = índice/cola operacional
Cron/worker         = keeper que intenta ejecutar
Smart contract      = enforcement final
```

## Problema actual

Hoy `BACK/services/conditionalOrders.ts` usa:

- `Map()` en memoria para indexar órdenes.
- `setInterval()` para polling de órdenes y oráculos.
- ejecución automática solo si `CONDITIONAL_ORDER_KEEPER_ENABLED=true` y hay keeper keypair.

Esto sirve para demo local o proceso Node persistente, pero tiene problemas para producción/serverless:

1. **La memoria se pierde** si la instancia muere.
2. **Los intervals no son confiables** en Vercel/serverless.
3. **No hay cola persistente** de trabajo pendiente.
4. **No hay locking fuerte** si hay más de una instancia/cron corriendo.
5. **El backoff de errores se pierde** al reiniciar.
6. **La observabilidad es pobre**: no queda historial persistente de intentos, fallos y razones.

## Objetivo

Crear una arquitectura robusta para órdenes condicionales que:

- persista el estado off-chain en DB;
- modele órdenes abiertas como una cola consultable por el keeper;
- ejecute un cron/worker periódico para verificar condiciones;
- evite doble ejecución mediante locks/idempotencia;
- conserve historial de intentos y errores;
- mantenga enforcement on-chain como garantía final;
- permita que la UI consulte estado actualizado sin depender de memoria local.

## No objetivos

Esta proposal no busca:

- cambiar la lógica on-chain de `conditional-escrow-buy`;
- reemplazar la validación on-chain por validación backend;
- custodiar fondos o claves de usuario en backend;
- implementar un DEX/matching engine;
- garantizar ejecución instantánea al tick exacto del precio;
- depender de Redis como fuente de verdad de órdenes.

## Decisión propuesta

Usar una tabla de DB como cola persistente de órdenes condicionales.

Decisión de DB:

- **DB:** Supabase Postgres.
- **Proveedor elegido:** Supabase.
- **Motivo:** el repo ya tiene `@supabase/supabase-js` disponible, Supabase ofrece Postgres administrado con SQL/migrations/RPC y Postgres permite locks/transacciones robustas para procesar la cola sin doble ejecución.

Redis puede seguir existiendo para sesiones de chat, pero para esta feature conviene DB relacional porque necesitamos:

- lifecycle auditable;
- historial de attempts;
- queries por usuario/status;
- locking transaccional;
- trazabilidad para UI/admin.

## Arquitectura propuesta

```txt
1. Usuario crea una tarea con el agente
   └─ el agente normaliza intención, condición y schedule
      └─ backend guarda la tarea en Supabase

2. DB actúa como cola de tareas
   └─ conditional_tasks.status = open
   └─ price_trigger: next_check_at <= now()
   └─ cron_recurring: next_run_at <= now()

3. QStash despierta al keeper global cada 30s
   └─ toma lote de tareas candidatas con lock
   └─ evalúa precio, cron y policy según tipo
   └─ si no cumple: agenda próximo check/run
   └─ si cumple: materializa o ejecuta la orden/acción

4. Programa Solana valida cuando hay acción on-chain
   └─ si pasa: ejecuta settlement y marca on-chain Executed
   └─ si falla: no hay transferencias parciales

5. Backend persiste resultado
   └─ tx_signature, status, last_error, attempts, timestamps, next_run_at
```

## Modelo mental de la cola

No es una cola tipo RabbitMQ. Es una **queue table**.

Hay que distinguir dos conceptos:

1. **Tarea del agente**: intención persistida en DB, por ejemplo "comprá SOL cuando baje de 130" o "todos los lunes comprá X".
2. **Orden/ejecución on-chain**: instancia concreta creada o ejecutada cuando una tarea queda lista.

La función nueva del agente debe guardar tareas en Supabase. Cada tarea tiene un tipo de schedule y una próxima fecha de evaluación/ejecución.

Tipos iniciales:

| Tipo             | Ejemplo                      | Cómo se programa                   | Cómo se procesa                                                                       |
| ---------------- | ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `price_trigger`  | "Cuando SOL baje de 130 USD" | `next_check_at` cada 30s o backoff | El keeper la revisa en cada tick global de QStash hasta que el precio cumpla.         |
| `cron_recurring` | "Todos los lunes comprá X"   | `schedule_cron` + `next_run_at`    | El keeper chequea si `next_run_at <= now()`, ejecuta y calcula la próxima ocurrencia. |

Una tarea está lista para ser revisada si:

```sql
status IN ('open', 'waiting_condition', 'retryable_error')
AND (
  (schedule_type = 'price_trigger' AND next_check_at <= now())
  OR
  (schedule_type = 'cron_recurring' AND next_run_at <= now())
)
AND (locked_until IS NULL OR locked_until < now())
```

El cron toma un batch, bloquea esas filas y las procesa.

```txt
conditional_tasks
  ├─ open + next_check_at vencido      → candidata price trigger
  ├─ open + next_run_at vencido        → candidata cron recurring
  ├─ checking                          → tomada por worker
  ├─ executable                        → condición observada como lista
  ├─ executing                         → tx en curso
  ├─ executed                          → one-shot confirmado
  ├─ scheduled_next                    → recurrente ejecutada y reagendada
  ├─ expired                           → vencida
  ├─ cancelled                         → cancelada
  └─ failed_terminal                   → error no recuperable
```

## Función del agente para guardar tareas

Agregar una tool/function server-side para que el agente persista tareas normalizadas:

```txt
save_conditional_task(params)
```

Responsabilidades:

- interpretar la intención natural del usuario;
- clasificar `schedule_type` como `price_trigger` o `cron_recurring`;
- normalizar parámetros de acción: asset, monto, token de pago, destinatario, límites y policy;
- para `price_trigger`, guardar condición de mercado y `next_check_at` inicial;
- para `cron_recurring`, inferir y guardar `schedule_cron`, timezone y `next_run_at`;
- devolver un resumen confirmable al usuario antes de activar ejecución automática;
- no guardar secrets ni claves de usuario;
- no firmar por el usuario.

Ejemplos:

```json
{
  "schedule_type": "price_trigger",
  "condition": {
    "kind": "price_below",
    "asset": "SOL",
    "price_usd": 130
  },
  "action": {
    "kind": "buy_sol",
    "amount_usdc": 50
  },
  "next_check_at": "2026-05-12T12:00:00Z"
}
```

```json
{
  "schedule_type": "cron_recurring",
  "schedule_cron": "0 9 * * 1",
  "timezone": "America/Argentina/Buenos_Aires",
  "action": {
    "kind": "buy_sol",
    "amount_usdc": 25
  },
  "next_run_at": "2026-05-18T12:00:00Z"
}
```

Nota: el cron se guarda en DB para la tarea. QStash no crea un schedule por tarea; QStash solo despierta al keeper global. El keeper compara `next_run_at` contra `now()` y, si ejecuta una tarea recurrente, calcula y guarda la siguiente ocurrencia.

## Tabla principal: `conditional_tasks`

Campos propuestos:

| Campo                    | Tipo                  | Descripción                                          |
| ------------------------ | --------------------- | ---------------------------------------------------- |
| `id`                     | uuid                  | ID interno DB.                                       |
| `task_id`                | uuid unique           | ID de tarea persistente del agente.                  |
| `order_pda`              | text nullable         | PDA de la orden on-chain si ya existe una instancia. |
| `user_address`           | text                  | Wallet owner.                                        |
| `recipient_address`      | text                  | Destinatario de SOL.                                 |
| `client_order_id`        | bigint/text nullable  | ID usado para derivar PDA cuando aplique.            |
| `network`                | text                  | MVP: `devnet`.                                       |
| `program_id`             | text nullable         | Programa `conditional-escrow-buy` cuando aplique.    |
| `status`                 | enum/text             | Estado operacional DB.                               |
| `schedule_type`          | enum/text             | `price_trigger` o `cron_recurring`.                  |
| `schedule_cron`          | text nullable         | Cron normalizado para tareas recurrentes.            |
| `timezone`               | text nullable         | Timezone usado para calcular el próximo run.         |
| `next_run_at`            | timestamptz nullable  | Próxima ejecución para `cron_recurring`.             |
| `next_check_at`          | timestamptz nullable  | Próximo chequeo para `price_trigger`.                |
| `last_run_at`            | timestamptz nullable  | Última ejecución/intento efectivo.                   |
| `onchain_status`         | enum/text nullable    | Último estado leído desde Solana si aplica.          |
| `action_kind`            | text                  | Ej: `buy_sol`, `transfer`, `swap`.                   |
| `action_params`          | jsonb                 | Parámetros normalizados de la acción.                |
| `condition_kind`         | text nullable         | Ej: `price_below`, `price_above`.                    |
| `condition_params`       | jsonb nullable        | Parámetros normalizados de condición.                |
| `desired_sol_lamports`   | numeric/text nullable | Cantidad objetivo de SOL.                            |
| `max_usdc_in`            | numeric/text nullable | Máximo USDC permitido.                               |
| `target_price_usd_e8`    | numeric/text nullable | Precio objetivo.                                     |
| `oracle_feed`            | text nullable         | Feed Pyth esperado.                                  |
| `max_oracle_age_seconds` | integer nullable      | Staleness permitido.                                 |
| `max_confidence_bps`     | integer nullable      | Confianza máxima permitida.                          |
| `escrow_token_account`   | text nullable         | Cuenta escrow SPL si existe.                         |
| `treasury_usdc_ata`      | text nullable         | Treasury USDC.                                       |
| `sol_vault_pda`          | text nullable         | Vault SOL.                                           |
| `expires_at`             | timestamptz nullable  | Expiración de la tarea/orden.                        |
| `locked_by`              | text nullable         | ID del worker que tomó la fila.                      |
| `locked_until`           | timestamptz nullable  | TTL del lock.                                        |
| `attempt_count`          | integer               | Intentos de ejecución/check con error.               |
| `last_observed_price_e8` | numeric/text nullable | Último precio observado.                             |
| `last_observed_at`       | timestamptz nullable  | Cuándo se observó precio/estado.                     |
| `last_executable_reason` | text nullable         | `ready`, `price_above_target`, `oracle_stale`, etc.  |
| `last_error_code`        | text nullable         | Error operacional.                                   |
| `last_error_message`     | text nullable         | Mensaje sanitizado.                                  |
| `last_tx_signature`      | text nullable         | Última tx de ejecución enviada.                      |
| `executed_at`            | timestamptz nullable  | Confirmación de ejecución.                           |
| `created_at`             | timestamptz           | Creación DB.                                         |
| `updated_at`             | timestamptz           | Última actualización DB.                             |

Notas:

- Para montos grandes, preferir `numeric` o string decimal, no `number` JS persistido sin cuidado.
- `task_id` debe ser unique para idempotencia de la tarea.
- `order_pda` debe ser unique cuando exista, para idempotencia on-chain.
- La DB puede guardar snapshot de parámetros, pero debe reconciliar con on-chain.
- Para `cron_recurring`, `schedule_cron` debe parsearse y validarse antes de guardar.
- Para `cron_recurring`, luego de una ejecución exitosa se recalcula `next_run_at`; si la tarea no es recurrente, se marca terminal.

## Tabla de eventos: `conditional_task_events`

Para observabilidad y debugging:

| Campo          | Tipo          | Descripción                                                               |
| -------------- | ------------- | ------------------------------------------------------------------------- |
| `id`           | uuid          | ID evento.                                                                |
| `task_id`      | uuid          | Tarea asociada.                                                           |
| `order_pda`    | text nullable | Orden on-chain asociada, si existe.                                       |
| `event_type`   | text          | `created`, `checked`, `ready`, `execute_sent`, `executed`, `failed`, etc. |
| `reason`       | text nullable | Razón funcional u operacional.                                            |
| `tx_signature` | text nullable | Signature asociada.                                                       |
| `metadata`     | jsonb         | Snapshot sin secrets.                                                     |
| `created_at`   | timestamptz   | Timestamp.                                                                |

Esto evita depender de logs efímeros.

## Estados DB propuestos

| Estado              | Significado                                          |
| ------------------- | ---------------------------------------------------- |
| `open`              | Tarea activa, pendiente de condición o fecha.        |
| `checking`          | Worker la tomó temporalmente. Puede volver a `open`. |
| `waiting_condition` | Última evaluación no cumple condición.               |
| `executable`        | Off-chain observó que parece ejecutable.             |
| `executing`         | Se envió o se está enviando `execute_order`.         |
| `executed`          | Settlement/acción confirmada para tarea one-shot.    |
| `scheduled_next`    | Tarea recurrente ejecutada y reprogramada.           |
| `cancelled`         | On-chain cancelada por usuario.                      |
| `expired`           | Venció y no debe ejecutarse.                         |
| `reclaimed`         | Fondos reclamados post-expiry.                       |
| `retryable_error`   | Error temporal, se reintentará con backoff.          |
| `failed_terminal`   | Error no recuperable sin intervención.               |

Importante: `executable` es estado observado por backend. No es garantía. La garantía la da `execute_order` on-chain.

## Cron / worker

### Opción A elegida: Upstash QStash Schedule + endpoint cron

Ruta propuesta:

```txt
POST /api/cron/conditional-orders
```

El polling recurrente no debe implementarse como un `while true` ni como `setInterval` dentro del request principal de Next. Debe venir de **Upstash QStash**, que invoca este endpoint de forma programada.

Decisión:

- **Scheduler:** Upstash QStash.
- **Frecuencia objetivo:** cada 30 segundos.
- **Endpoint receptor:** `POST /api/cron/conditional-orders`.
- **Verificación:** firma QStash mediante `Upstash-Signature` y `@upstash/qstash/nextjs`.
- **Modelo de scheduling:** dos schedules globales, no un cron por orden condicional de precio.

Investigación relevante de QStash:

- QStash permite crear schedules agregando el header `Upstash-Cron` a un publish/schedule request.
- Los cron examples oficiales usan formato cron estándar de 5 campos, por ejemplo `* * * * *` para cada minuto.
- QStash permite `Upstash-Delay`, incluyendo valores como `30s`.
- En schedules, `Upstash-Delay` retrasa la entrega de cada mensaje creado por el schedule; no cambia la frecuencia base del schedule.
- Para lograr ticks cada 30 segundos con cron de minuto, usar dos schedules hacia el mismo endpoint:
  - schedule A: `* * * * *` sin delay;
  - schedule B: `* * * * *` con `Upstash-Delay: 30s`.
- QStash firma cada request con un JWT en el header `Upstash-Signature`.
- En Next App Router se puede usar `verifySignatureAppRouter` de `@upstash/qstash/nextjs`.
- QStash reintenta automáticamente si el endpoint no responde con status `2XX`; agrega `Upstash-Retried` para indicar reintentos.

Configuración operacional de schedules:

```txt
Schedule A — global ticker inmediato
  cron: * * * * *
  delay: none
  destination: https://<app-domain>/api/cron/conditional-orders

Schedule B — global ticker desplazado
  cron: * * * * *
  delay: 30s
  destination: https://<app-domain>/api/cron/conditional-orders
```

Estos schedules son infraestructura del keeper. No se crean por cada orden de precio. Cada orden vive como fila en Supabase con `next_check_at`, `status`, locks y parámetros de condición. Cuando una orden queda ejecutada/cancelada/expirada, se marca terminal en DB y el ticker global deja de tomarla.

Ventajas:

- compatible con serverless;
- no bloquea la app ni depende de memoria local;
- cada ejecución procesa un batch finito y devuelve respuesta;
- QStash aporta delivery HTTP, scheduling, firma, retries y logs operacionales;
- el patrón de dos schedules permite una cadencia efectiva de 30 segundos sin mantener un proceso vivo.

Limitaciones:

- no es ejecución en tiempo real; el SLA funcional es próximo tick de 30 segundos más latencia de Solana/RPC;
- las corridas pueden solaparse si una tarda más de 30 segundos, por eso son obligatorios locks persistentes en Supabase;
- los retries de QStash pueden duplicar una entrega, por eso el handler debe ser idempotente;
- el endpoint debe ser público para QStash, pero protegido por firma QStash.

### Opción B: Worker persistente

Proceso separado:

```txt
npm run worker:conditional-orders
```

Ventajas:

- puede correr cada 5-10 segundos;
- mejor para ejecución real;
- menos acoplado a request lifecycle.

Desventaja:

- requiere hosting adicional: Fly.io, Railway, Render, VPS, Cloud Run, etc.

### Recomendación

Implementar una abstracción común de keeper:

```txt
BACK/services/conditionalOrderKeeper.ts
  └─ processDueConditionalTasks(options)
```

Y exponer dos entrypoints:

```txt
app/api/cron/conditional-orders/route.ts
scripts/conditional-order-worker.mjs
```

Así el MVP usa QStash cada 30 segundos, y luego se puede correr como worker sin reescribir la lógica si hace falta reducir latencia o independizarse del request lifecycle.

## Polling sin bloquear el hilo principal

El diseño propuesto evita bloquear el hilo principal con estas reglas:

1. **No hay loop infinito dentro de Next:** el backend no queda "escuchando" con `while` ni `setInterval` en memoria.
2. **Un scheduler externo dispara el trabajo:** cada 30 segundos hace `POST /api/cron/conditional-orders`.
3. **Cada request procesa un batch acotado:** `CONDITIONAL_ORDER_BATCH_SIZE` limita cuántas órdenes se revisan por corrida.
4. **Cada corrida tiene presupuesto de tiempo:** el handler debe cortar antes del timeout de la plataforma y dejar el resto para la próxima corrida.
5. **I/O asincrónico:** llamadas a Supabase, Solana RPC y oráculos se hacen con `await`; no se hace CPU-bound polling que bloquee el event loop.
6. **Locks persistentes:** si dos corridas se pisan, Supabase/Postgres bloquea filas con `FOR UPDATE SKIP LOCKED` o RPC equivalente.
7. **Idempotencia on-chain:** aunque un job se repita, el programa Solana vuelve a validar estado y evita doble settlement.

Modelo operativo:

```txt
QStash Schedule A cada minuto
QStash Schedule B cada minuto + delay 30s
  → POST /api/cron/conditional-orders
    → verificar firma Upstash-Signature
    → tomar batch con lock en Supabase
    → verificar Solana + oracle
    → ejecutar si corresponde
    → actualizar DB
    → responder 2XX y liberar el request
```

Esto no mantiene ocupado el servidor entre ejecuciones. Entre un tick y el siguiente no hay proceso esperando dentro de la app Next.

## Cron por tarea vs ticker global

Para condiciones de precio como "comprá SOL cuando baje de 130 USD", no se puede inferir un cron exacto por tarea porque no sabemos cuándo va a ocurrir el evento de mercado. Crear un schedule QStash por orden para revisar cada 30 segundos duplicaría trabajo, aumentaría costo y complicaría cancelación.

El modelo correcto para el MVP es:

```txt
QStash global ticker cada 30s
  → lee Supabase
  → toma tareas vencidas por next_check_at o next_run_at
  → evalúa condiciones de precio o cron
  → ejecuta las listas
  → marca terminales o recalcula próxima ocurrencia
```

Responsabilidad del agente/backend al crear una tarea:

1. Interpretar la intención del usuario.
2. Crear la orden on-chain cuando corresponda, o dejar la tarea lista para materializar una orden futura.
3. Insertar/upsert de la fila en `conditional_tasks` con `next_check_at` o `next_run_at` inicial.
4. Guardar tipo de condición, cron si aplica y parámetros normalizados.
5. No crear un schedule QStash dedicado por tarea de precio ni por tarea recurrente; el cron vive como dato en DB.

Responsabilidad del keeper:

1. Levantarse por QStash cada 30 segundos.
2. Tomar filas candidatas.
3. Evaluar y ejecutar.
4. Si no cumple price trigger, actualizar `next_check_at`.
5. Si cron recurring está vencido, ejecutar y recalcular `next_run_at`.
6. Si una tarea one-shot cumple y ejecuta, marcar `executed` y liberar/cerrar la tarea.

Para tareas recurrentes tipo "todos los lunes", tampoco se crea un QStash schedule por tarea. Se guarda `schedule_cron` en Supabase, se calcula `next_run_at`, y el ticker global la ejecuta cuando vence. Luego recalcula la siguiente fecha. Esto permite pausar/cancelar una tarea cambiando su `status` en DB, sin tener que administrar schedules remotos por cada usuario.

Excepción futura: para condiciones puramente temporales one-shot con fecha exacta, por ejemplo "ejecutá el 15 de junio a las 10:00", se puede usar un mensaje QStash one-shot con `Upstash-Delay` o `Upstash-Not-Before`. Esa no es la ruta principal para price triggers ni cron recurrings.

## Presupuesto de tiempo por corrida

Aunque Vercel Functions puede permitir duraciones largas según plan/configuración y Next permite `export const maxDuration`, este endpoint no debe usar todo ese margen. Como QStash dispara cada 30 segundos, la corrida debe terminar antes del siguiente tick para reducir solapes.

Decisión recomendada:

- `export const runtime = 'nodejs'`.
- `export const maxDuration = 25` en `app/api/cron/conditional-orders/route.ts`.
- Presupuesto interno de trabajo: **20 segundos**.
- Margen de cierre/respuesta: **5 segundos**.
- `CONDITIONAL_ORDER_LOCK_TTL_SECONDS=60` para cubrir una corrida lenta o un retry.
- `CONDITIONAL_ORDER_BATCH_SIZE` inicial bajo, por ejemplo 10-20, ajustable por métricas.

El handler debe implementar deadline interno:

```txt
startedAt = now()
deadline = startedAt + 20s

while hay tareas candidatas y now() < deadline:
  procesar siguiente tarea

si queda trabajo:
  responder 200 con has_more=true
  la próxima corrida QStash continúa
```

Si el endpoint llega cerca del deadline, debe devolver `2XX` con resumen parcial. No debe esperar hasta que Vercel o QStash lo corten, porque eso dispara retries y puede generar trabajo duplicado.

## Algoritmo del keeper

```txt
processDueConditionalTasks(batchSize):
  1. tomar tareas candidatas desde DB con lock:
     - `price_trigger` con `next_check_at <= now()`
     - `cron_recurring` con `next_run_at <= now()`
  2. por cada tarea:
     a. validar policy y estado de la tarea
     b. si `price_trigger`, leer oracle/feed y evaluar condición off-chain
     c. si `cron_recurring`, validar que la ocurrencia cron esté vencida
     d. si todavía no cumple, guardar reason y próximo `next_check_at`/`next_run_at`
     e. si cumple, materializar o cargar la orden/acción on-chain necesaria
     f. antes de ejecutar, releer estado on-chain si hay `order_pda`
     g. marcar `executing` y llamar ejecución correspondiente
     h. confirmar tx
     i. refrescar on-chain
     j. si es one-shot, marcar `executed` o `retryable_error`
     k. si es recurrente y ejecutó, recalcular `next_run_at` y marcar `scheduled_next`
  3. detenerse si se acerca el deadline interno de 20s
  4. liberar locks siempre con finally/TTL
  5. devolver resumen parcial si queda trabajo para el próximo tick
```

## Locking e idempotencia

Para evitar doble ejecución si dos cron corren a la vez:

- tomar filas con transacción DB;
- usar `FOR UPDATE SKIP LOCKED` cuando esté disponible;
- setear `locked_by` y `locked_until`;
- renovar o liberar lock al terminar;
- `order_pda` unique;
- antes de ejecutar, releer on-chain;
- después de enviar tx, confirmar y volver a reconciliar.

Pseudo SQL:

```sql
WITH picked AS (
  SELECT id
  FROM conditional_tasks
  WHERE status IN ('open', 'waiting_condition', 'retryable_error', 'scheduled_next')
    AND (
      (schedule_type = 'price_trigger' AND next_check_at <= now())
      OR
      (schedule_type = 'cron_recurring' AND next_run_at <= now())
    )
    AND (locked_until IS NULL OR locked_until < now())
  ORDER BY next_check_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE conditional_tasks co
SET status = 'checking',
    locked_by = $2,
    locked_until = now() + interval '60 seconds',
    updated_at = now()
FROM picked
WHERE co.id = picked.id
RETURNING co.*;
```

## Backoff

Cuando falla un check o ejecución por error temporal:

```txt
next_check_at = now + min(base_delay * 2^attempt_count, max_delay)
```

Valores iniciales sugeridos:

- check normal: 15-60 segundos;
- error RPC/oráculo: 1-5 minutos;
- fallo de ejecución recuperable: 45s, 90s, 180s, máximo 15 minutos;
- terminal: no reintentar hasta intervención.

## Reconciliación con Solana

Cada corrida debe asumir que la DB puede estar vieja.

Antes de ejecutar:

1. leer cuenta on-chain de la orden;
2. verificar status on-chain `Open`;
3. verificar parámetros críticos contra DB;
4. leer oráculo;
5. evaluar off-chain solo como filtro;
6. llamar `execute_order`;
7. dejar que el programa valide de nuevo.

Si DB dice `open` pero on-chain dice `executed`, gana on-chain.

## API propuesta

### Cron interno

```txt
POST /api/cron/conditional-orders
```

Responsabilidad:

- validar secret de cron/header interno;
- llamar `processDueConditionalTasks()`;
- devolver resumen de batch.

Respuesta ejemplo:

```json
{
  "processed": 12,
  "executed": 1,
  "waiting": 9,
  "retryable_errors": 2,
  "terminal_errors": 0
}
```

### Reindex manual/admin

```txt
POST /api/conditional-orders/reindex
```

Responsabilidad:

- escanear program accounts;
- upsert en DB;
- útil si se perdió un evento o se migró estado.

### Consulta usuario

Actualizar existente:

```txt
GET /api/conditional-orders?user=<wallet>
```

Ahora debería leer principalmente desde DB y reconciliar bajo demanda si hace falta.

### Detalle orden

Actualizar existente:

```txt
GET /api/conditional-orders/:orderPda
```

Debe devolver:

- snapshot DB;
- último estado on-chain conocido;
- `observedExecutable`;
- `observedExecutableReason`;
- `lastTxSignature`;
- eventos recientes opcionales.

## Seguridad

- El cron debe verificar la firma de QStash (`Upstash-Signature`) antes de procesar cualquier orden.
- Usar `@upstash/qstash/nextjs` con `verifySignatureAppRouter` para Next App Router.
- Mantener `QSTASH_CURRENT_SIGNING_KEY` y `QSTASH_NEXT_SIGNING_KEY` solo server-side.
- `QSTASH_TOKEN` solo se usa para crear/administrar schedules o publicar mensajes, nunca en frontend.
- `CONDITIONAL_ORDER_CRON_SECRET` queda como defensa opcional adicional, pero la autenticación principal del endpoint será la firma QStash.
- Configurar `export const maxDuration = 25` y deadline interno de 20s para evitar timeouts y retries innecesarios.
- La keeper keypair solo firma la transacción de ejecución propia; nunca firma por el usuario.
- El frontend no debe consultar providers privados directamente.
- La DB no puede autorizar ejecución por sí sola.
- El contrato debe seguir validando oracle, estado, fondos y límites.
- Los errores persistidos deben sanitizarse para no guardar secrets.
- Si el endpoint responde no-2XX, QStash puede reintentar; por eso cada corrida debe ser idempotente.

## Configuración esperada

Nuevas env vars propuestas:

```txt
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
CONDITIONAL_ORDER_CRON_SECRET=
CONDITIONAL_ORDER_KEEPER_ENABLED=true
CONDITIONAL_ORDER_KEEPER_KEYPAIR=
CONDITIONAL_ORDER_BATCH_SIZE=20
CONDITIONAL_ORDER_CHECK_INTERVAL_SECONDS=30
CONDITIONAL_ORDER_RUN_BUDGET_SECONDS=20
CONDITIONAL_ORDER_ROUTE_MAX_DURATION_SECONDS=25
CONDITIONAL_ORDER_LOCK_TTL_SECONDS=60
CONDITIONAL_ORDER_MAX_BACKOFF_SECONDS=900
```

Notas:

- `SUPABASE_SERVICE_ROLE_KEY`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` y `CONDITIONAL_ORDER_KEEPER_KEYPAIR` son server-side únicamente.
- No exponer ninguna de estas variables como `NEXT_PUBLIC_*`.
- `QSTASH_TOKEN` no hace falta en runtime del endpoint receptor si los schedules se crean manualmente desde la consola; sí hace falta si agregamos script de bootstrap/administración de schedules.

## Impacto en archivos

Probables archivos a crear:

```txt
BACK/services/conditionalTaskRepository.ts
BACK/services/conditionalTaskKeeper.ts
BACK/services/conditionalTaskEvents.ts
BACK/services/tools/saveConditionalTask.ts
app/api/cron/conditional-orders/route.ts
app/api/conditional-orders/reindex/route.ts
scripts/bootstrap-qstash-conditional-orders.mjs
scripts/conditional-order-worker.mjs
supabase/migrations/<timestamp>_conditional_tasks.sql
```

Probables archivos a modificar:

```txt
package.json
BACK/services/conditionalOrders.ts
BACK/services/chat.ts
app/api/conditional-orders/route.ts
app/api/conditional-orders/[orderPda]/route.ts
FRONT/src/hooks/useConditionalOrders.ts
FRONT/src/components/wallet/ConditionalOrdersPanel.tsx
FRONT/src/lib/api/client.ts
FRONT/src/lib/api/schemas.ts
FRONT/src/types/api.ts
README.md
```

Dependencia nueva esperada:

```txt
@upstash/qstash
```

## Plan por fases

### Fase 1 - DB schema y repository

- Crear migración de tablas.
- Implementar repository server-side.
- Upsert de orden por `order_pda`.
- Eventos básicos.

Resultado:

```txt
La app puede persistir y consultar tareas desde DB.
```

### Fase 2 - Reindex desde Solana

- Extraer parte de `pollConditionalOrders()` a un servicio reusable.
- Crear endpoint/admin job de reindex.
- Sincronizar on-chain status hacia DB.

Resultado:

```txt
DB puede reconstruirse desde Solana.
```

### Fase 3 - Keeper cron

- Crear `processDueConditionalTasks()`.
- Implementar batch locking.
- Evaluar oráculo, condición de precio o vencimiento cron.
- Actualizar `next_check_at`, `next_run_at` y reasons.

Resultado:

```txt
El cron procesa cola persistente y marca waiting/executable/retryable.
```

### Fase 4 - Ejecución automática

- Integrar `sendExecuteTx()` al keeper.
- Confirmar tx y reconciliar on-chain.
- Persistir signature/eventos.
- Implementar backoff.

Resultado:

```txt
Las órdenes listas se ejecutan automáticamente si keeper está habilitado.
```

### Fase 5 - UI y observabilidad

- UI lee estado DB + on-chain snapshot.
- Mostrar `next_check_at`, último precio, último error y tx.
- Agregar estados claros: waiting, executable, executing, executed.

Resultado:

```txt
El usuario entiende si la orden está esperando, lista, ejecutándose o fallando.
```

## Criterios de aceptación

- Una tarea creada por el agente queda persistida en DB con `task_id` unique.
- Si la tarea materializa orden on-chain, `order_pda` queda persistido y unique.
- Si el proceso backend se reinicia, las tareas siguen disponibles desde DB y las órdenes desde Solana.
- El cron procesa tareas por `next_check_at` o `next_run_at` sin depender de memoria local.
- Dos corridas concurrentes no ejecutan la misma orden dos veces.
- El keeper revalida estado on-chain antes de intentar ejecución.
- Si la condición de precio no se cumple, se guarda reason y se agenda próximo check.
- Si una tarea cron recurrente vence, se ejecuta y se recalcula próxima ocurrencia.
- Si la condición se cumple, se intenta la ejecución correspondiente y se persiste signature/resultado.
- Si la ejecución falla por causa temporal, se aplica backoff persistente.
- Si la orden fue ejecutada/cancelada/expirada on-chain, DB se reconcilia aunque el estado local estuviera viejo.
- La UI muestra estado persistente y no depende de `Map()` en memoria.
- El smart contract sigue siendo la garantía final; DB/cron no pueden bypassear guards.

## Riesgos y mitigaciones

| Riesgo                                   | Mitigación                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Cron demasiado lento para precio volátil | Usar worker persistente para intervalos sub-minuto.                                                       |
| Doble ejecución por concurrencia         | DB locks + on-chain status check + atomicidad del programa.                                               |
| DB stale vs Solana                       | Reconciliar antes y después de ejecutar; on-chain gana siempre.                                           |
| RPC rate limits                          | Batch size controlado, backoff, conexión centralizada, caching de oracle por feed.                        |
| Keeper keypair comprometida              | Limitar fondos/rol; recordar que solo puede intentar ejecución, no mover fondos fuera de reglas on-chain. |
| Errores invisibles                       | Tabla de eventos + métricas por batch.                                                                    |
| Secrets en frontend                      | Service role/cron secret solo server-side.                                                                |

## Decisiones resueltas

1. **Frecuencia de polling:** alcanza con 30 segundos.
2. **Scheduler:** usar Upstash QStash con dos schedules globales de un minuto: uno inmediato y otro con `Upstash-Delay: 30s`.
3. **No crear cron por tarea:** cada tarea vive en Supabase; QStash solo despierta al keeper global. Para recurrentes, el cron vive como `schedule_cron` en DB.
4. **Tiempo máximo por corrida:** route `maxDuration=25s`, presupuesto interno `20s`, lock TTL `60s`.
5. **Modo keeper:** debe ejecutar automáticamente cuando la condición se cumpla y `CONDITIONAL_ORDER_KEEPER_ENABLED=true`.
6. **Persistencia de precio/oracle:** guardar solo el último valor observado en `conditional_tasks`; los eventos pueden guardar metadata mínima, pero no snapshots completos por defecto.
7. **Network inicial:** solo devnet para el MVP. "Multi-network" significa soportar más de una red Solana, por ejemplo `devnet` y `mainnet-beta`, con programas, feeds, vaults y políticas distintas. Queda fuera del alcance inicial.

## Preguntas abiertas

1. ¿Los schedules QStash se crearán manualmente desde consola o con script `scripts/bootstrap-qstash-conditional-orders.mjs`?

## Recomendación final

Implementar primero DB + cron con una abstracción que después pueda correr como worker persistente.

Camino recomendado:

```txt
MVP robusto:
  Supabase Postgres + QStash schedules cada 30s + /api/cron/conditional-orders + locks + events

Luego:
  mismo processDueConditionalTasks() ejecutado por worker persistente
```

Esto mejora confiabilidad sin tocar la garantía principal: la ejecución válida sigue dependiendo del programa on-chain.
