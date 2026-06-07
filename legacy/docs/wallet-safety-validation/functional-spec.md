# Especificación Funcional — Wallet Public-Key Safety Validation

**Versión:** 1.1  
**Fecha:** 2026-05-10  
**Estado:** Draft para implementación

## 1. Alcance

### 1.1 Objetivo

Agregar un guardrail específico para transferencias en Solana que valide la seguridad de la wallet destino antes de emitir una propuesta de transferencia desde el chat.

El feature debe clasificar el resultado en tres estados de decisión:

- `ALLOW`: se puede continuar con aprobación explícita del usuario.
- `WARN`: se puede continuar solo con confirmación reforzada del usuario.
- `REJECT`: la acción queda bloqueada y no se prepara transacción.

### 1.2 Operaciones cubiertas

- Transferencia de `SOL` a una wallet destino.
- Diseño extensible para transferencia de `SPL tokens`, aunque el MVP puede priorizar `SOL`.

### 1.3 Fuera de alcance

- Swap de tokens.
- Ejecución automática recurrente.
- Firma backend por cuenta del usuario.
- Envío de transacciones firmadas al backend.
- Bloqueo on-chain de señales dinámicas que dependan de APIs externas sin oracle/attestation.

## 2. Problema a resolver

Hoy la validación de destino en transferencias es mínima: alcanza con que la dirección sea un `PublicKey` válido y que exista una wallet conectada. Eso no cubre destinos maliciosos, cuentas ejecutables, direcciones recién creadas, blocklists, reputación externa ni políticas de usuario.

El guardrail debe reducir el riesgo de enviar fondos a un destino incorrecto, sospechoso o explícitamente bloqueado, sin romper el flujo conversacional ni la aprobación humana.

## 3. Objetivos funcionales

- Validar sintáctica y semánticamente la wallet destino.
- Distinguir chequeos locales, on-chain RPC y off-chain/indexados.
- Inventariar explícitamente qué chequeos del feature son reales, cuáles dependen de configuración/env y cuáles siguen mockeados o solo reportan estado.
- Incorporar Solscan como señal indexada configurable para confirmar si el destinatario aparece indexado y con evidencia básica utilizable.
- Agregar una opinión textual opcional generada por LLM, basada solo en los chequeos ya ejecutados, como explicación secundaria para el usuario.
- Exponer razones claras de `ALLOW`, `WARN` o `REJECT`.
- Requerir confirmación reforzada para riesgo intermedio.
- Impedir que una transferencia rechazada genere propuesta aprobable o transacción preparada.
- Mantener trazabilidad del resultado de validación para auditoría.

## 4. Comportamiento esperado

### 4.1 Flujo de alto nivel

1. El usuario pide una transferencia en lenguaje natural.
2. El backend extrae `recipient`, `asset`, `amount` y contexto.
3. El guardrail ejecuta validaciones de destino y de política.
4. El sistema calcula decisión `ALLOW`, `WARN` o `REJECT`.
5. Si el resultado es `ALLOW` o `WARN`, se crea una propuesta pendiente con detalle de riesgo.
6. El frontend muestra el resumen, razones y requerimiento de confirmación.
7. El usuario aprueba o rechaza.
8. Si el usuario aprueba, el backend prepara una transacción unsigned y la devuelve al frontend.
9. El frontend solicita a Phantom injected firmar y enviar la transacción.
10. Phantom devuelve `tx_signature` o error/cancelación.
11. El frontend muestra estado `submitted`, `confirming`, `confirmed`, `failed` o `cancelled`.

Para transferencias simples, el backend nunca recibe `signed_tx_base64` ni envía la transacción. Puede recibir opcionalmente `tx_signature` mediante `function_result` para auditoría o continuidad conversacional.

La verificación on-chain de `ActionApproval`/`AgentActionGuard` aplica solo a acciones que estén explícitamente modeladas como guarded actions. No es requisito del MVP de transferencia simple Phantom-first.

### 4.2 Estados de decisión

#### `ALLOW`

Aplica cuando:

- La public key es válida.
- La cuenta destino no es ejecutable.
- No hay coincidencias en blocklists críticas.
- No hay señales externas críticas.
- El monto y la política del usuario permiten la operación.

Resultado esperado:

- Se genera propuesta normal.
- Se requiere confirmación explícita del usuario.
- La UI muestra riesgo bajo.
- Al aprobar, el backend devuelve una unsigned transaction para que Phantom firme y envíe desde frontend.

#### `WARN`

Aplica cuando no existe causal de rechazo, pero sí señales de atención. Ejemplos:

- Cuenta nueva o con muy poco historial.
- Cuenta válida pero sin evidencia suficiente por indisponibilidad parcial de proveedores.
- Reportes externos de baja confianza.
- Destino no allowlisted para un monto superior a un umbral de precaución.

Resultado esperado:

- Se genera propuesta.
- La UI exige confirmación reforzada.
- Deben mostrarse advertencias concretas y entendibles.
- Si el usuario confirma el warning, el flujo de firma/envío sigue siendo Phantom injected en frontend.

#### `REJECT`

Aplica cuando hay causal dura de bloqueo. Ejemplos:

- Public key inválida.
- Cuenta ejecutable.
- Dirección en denylist del usuario o blocklist interna.
- Match crítico en sanciones o proveedor de abuso.
- Parámetros no coinciden con aprobación/política vigente.

Resultado esperado:

- No se genera propuesta aprobable.
- No se construye transacción.
- La respuesta al usuario explica el motivo de bloqueo.

## 5. Validaciones funcionales requeridas

### 5.1 Chequeos mínimos MVP

- Formato válido de `Solana public key`.
- La dirección destino puede coincidir con la wallet origen; self-transfer no se bloquea por policy local.
- Verificación RPC de cuenta:
  - existencia o ausencia de cuenta,
  - `owner`,
  - `executable`,
  - `lamports`,
  - `data` mínima útil para clasificación.
- Rechazo de cuentas ejecutables.
- Blocklist/denylist interna.
- Allowlist/denylist del usuario si existe configuración.
- Kill-switch de listas críticas cuando estén disponibles:
  - sanciones/OFAC,
  - HAPI,
  - Chainabuse,
  - GoPlus malicious address.
- Umbrales por monto y frecuencia según política.
- Señales externas de reputación o abuso cuando haya proveedor disponible.
- Verificación indexada en Solscan cuando esté configurada:
  - registrar `provider=solscan`,
  - clasificar estado `ok`, `missing` o `error`,
  - distinguir entre dirección encontrada/indexada y dirección sin evidencia indexada.
- Política explícita de degradación si un proveedor falla.

### 5.2 Validaciones recomendadas posteriores

- Historial enriquecido de transacciones del destinatario.
- Antigüedad aproximada de la cuenta.
- Clasificación del destino: wallet de usuario, programa, exchange, PDAs conocidas, ATA, escrow o contrato.
- Riesgo por contrapartes previas, clustering o reportes de fraude.
- Identidad/reputación positiva por SNS/ANS, SAS o Civic Pass, sin penalizar su ausencia.
- Normalización de aliases/labels conocidas.

### 5.3 Reglas funcionales específicas de Solscan

- Solscan se trata como fuente `indexed/off-chain`, no como verificación determinística on-chain.
- Si Solscan está configurado, el backend debe consultar si el `recipient` aparece indexado o con historial utilizable.
- Si Solscan responde que la dirección no existe, no está indexada o no tiene evidencia suficiente según el contrato definido, la decisión no puede terminar en `ALLOW` por esa vía.
- En ese caso, la salida debe incluir al menos el código estable `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`.
- Si Solscan falla por timeout, `429`, `5xx` u otro error operativo, la salida debe registrar `PROVIDER_PARTIAL_FAILURE` y `provider=solscan` con `status=error`.
- Un error de Solscan no puede degradar silenciosamente a `ALLOW`; el resultado final debe permanecer al menos en `WARN`, salvo que exista una causal dura de `REJECT`.
- Si Solscan confirma indexación/historial y no existen rechazos duros ni advertencias materiales adicionales, esa evidencia puede reducir advertencias de bajo nivel basadas solo en falta de contexto.

### 5.4 Inventario actual de chequeos: real vs mock/status-only

#### Chequeos reales locales

- Parseo y canonicalización de `PublicKey`.
- Validación de `amount > 0`.
- Self-transfer permitido y tratado como una transferencia normal bajo el resto de guardrails.

#### Chequeos reales por política/env

- Umbral de warning por monto.
- Umbral máximo de transferencia.
- Política de allowlist por monto.
- Blocklist/allowlist/denylist internas definidas por env/config.
- Lista estática de wallets sancionadas definida por env/config.

#### Chequeos reales por RPC

- `getAccountInfo` usando `SOLANA_RPC_URL`.
- Rechazo de cuentas `executable=true`.
- Clasificación de cuenta no encontrada como warning.
- Si RPC falla, el resultado conserva degradación explícita y puede caer al estado fuente `mock` o `providerStatus=error` según la rama implementada.

#### Chequeos reales de red condicionados por env

- Solscan cuando `WALLET_SAFETY_SOLSCAN_*` está habilitado.
- Si la dirección no aparece indexada: `WARN`.
- Si Solscan falla operativamente: `WARN` con degradación explícita.

#### Chequeos mock, status-only o no implementados

- HAPI: sin consulta reputacional viva; solo estado de proveedor ausente.
- Chainabuse: sin consulta viva; solo estado ausente.
- GoPlus: sin consulta viva; solo estado ausente.
- `abuseReports`: siempre vacío en el estado actual.
- No existe todavía un proveedor live de reputación externa consolidada para wallets.

### 5.5 Opinión textual opcional del agente

- El sistema puede adjuntar una opinión corta generada por LLM después de terminar la validación determinística.
- La opinión es estrictamente aditiva: no puede cambiar `ALLOW`, `WARN`, `REJECT`, `score`, `risk level` ni `requiresExtraConfirmation`.
- Debe basarse solo en un payload sanitizado con checks ejecutados, resultados y estados de proveedores.
- No debe incluir ni reutilizar texto libre del usuario para reducir riesgo de prompt injection.
- Si la generación falla, timeoutea o devuelve formato inválido, el flujo sigue sin bloquear y la propuesta se emite sin opinión.
- La UI debe mostrarla como opinión opcional del asistente, secundaria a los chequeos determinísticos.

## 6. Casos de uso

### CU-1: Transferencia a wallet segura

1. Usuario: "Enviá 0.2 SOL a esta wallet".
2. La dirección es válida y no presenta señales críticas.
3. El sistema responde con propuesta `ALLOW`.

Resultado:

- Se muestra resumen de transferencia.
- Se solicita aprobación normal.

### CU-2: Cuenta nueva o con contexto insuficiente

1. Usuario solicita transferencia a una wallet válida.
2. La cuenta existe o es sintácticamente válida, pero tiene bajo historial o faltan fuentes secundarias.
3. El sistema responde `WARN`.

Resultado:

- La UI muestra advertencias.
- Se requiere confirmación reforzada.

### CU-3: Dirección maliciosa o bloqueada

1. Usuario intenta transferir a una dirección presente en denylist o con señal crítica externa.
2. El sistema responde `REJECT`.

Resultado:

- No se genera propuesta.
- Se informa el motivo de bloqueo.

### CU-4: Dirección inválida

1. Usuario indica un string que no corresponde a un `PublicKey`.
2. El sistema responde `REJECT`.

Resultado:

- No se consulta infraestructura externa innecesariamente.
- Se informa error de formato.

### CU-5: Wallet no indexada en Solscan

1. Usuario solicita una transferencia a una wallet sintácticamente válida.
2. RPC no encuentra causal dura de rechazo.
3. Solscan está configurado y responde que la wallet no aparece indexada o no tiene evidencia suficiente.
4. El sistema responde `WARN`.

Resultado:

- La UI muestra que falta evidencia indexada en Solscan.
- La respuesta incluye `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`.
- No se promueve a `ALLOW` solo por haber pasado chequeos locales o RPC.

### CU-6: Falla operacional de Solscan

1. Usuario solicita una transferencia a una wallet válida.
2. Solscan está configurado pero responde con timeout, `429` o `5xx`.
3. No existe causal dura de rechazo por otras fuentes.
4. El sistema responde `WARN`.

Resultado:

- La UI muestra degradación parcial del análisis.
- La respuesta incluye `PROVIDER_PARTIAL_FAILURE`.
- El detalle de fuentes registra `provider=solscan` con `status=error`.

### CU-7: Opinión del agente disponible

1. Usuario solicita una transferencia.
2. El guardrail determinístico produce `ALLOW` o `WARN` y crea la propuesta.
3. La generación LLM está habilitada y devuelve JSON válido.

Resultado:

- La propuesta incluye una opinión breve y secundaria del agente.
- La opinión resume señales ya observadas, sin introducir nuevas reglas.
- La decisión determinística original permanece intacta.

### CU-8: Opinión del agente omitida por fallback

1. Usuario solicita una transferencia.
2. El guardrail determinístico produce un resultado válido.
3. La generación LLM está deshabilitada, falla, timeoutea o responde formato inválido.

Resultado:

- La propuesta se emite sin `agentOpinion`.
- No cambia el resultado `ALLOW`, `WARN` o `REJECT`.
- El usuario sigue viendo razones determinísticas normales.

## 7. Criterios de aceptación

- El sistema distingue `ALLOW`, `WARN` y `REJECT` para transferencias a wallet.
- Una public key inválida resulta en `REJECT`.
- Una cuenta `executable=true` resulta en `REJECT`.
- Un fallo de proveedor externo no produce aprobación silenciosa fuera de la política definida.
- Si Solscan configurado responde "not found" o "not indexed", la decisión no termina en `ALLOW` y expone `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`.
- Si Solscan configurado falla operativamente, la salida expone `PROVIDER_PARTIAL_FAILURE`, registra `provider=solscan` en error y la decisión queda al menos en `WARN` salvo `REJECT` por otra causa.
- Si Solscan confirma indexación/historial suficiente y no hay señales duras, esa evidencia puede reducir warnings de bajo contexto, pero no debe anular `REJECT`.
- La spec enumera explícitamente qué chequeos son reales, cuáles dependen de env y cuáles siguen mock/status-only.
- Una decisión `WARN` obliga confirmación reforzada en UI.
- Una decisión `REJECT` no crea propuesta pendiente ni transacción.
- El resultado incluye razones legibles para el usuario y códigos auditables para backend.
- La propuesta de transferencia incluye metadata de wallet safety dentro del resumen de riesgo.
- Si la opinión LLM está habilitada y la generación es exitosa, la propuesta incluye un texto corto secundario basado solo en checks sanitizados.
- Si la opinión LLM falla o devuelve JSON inválido, el flujo no se bloquea y la propuesta sigue sin esa opinión.
- La opinión LLM no modifica decisión, score, risk level ni requisitos de confirmación.
- Para transferencia simple, `function_approve` devuelve una transacción unsigned y el frontend la firma/envía con Phantom injected.
- El backend no recibe `signed_tx_base64`; cualquier callback posterior usa solo `tx_signature`/proof opcional.
- Si una acción guarded usa `AgentActionGuard`, el hash/approval debe permanecer consistente entre validación, propuesta y ejecución.

## 8. Mensajería al usuario

El sistema debe traducir el resultado técnico a mensajes accionables:

- `ALLOW`: "La wallet destino pasó los controles básicos y no presenta señales críticas."
- `WARN`: "La wallet destino puede ser válida, pero encontramos señales que requieren revisión adicional."
- `REJECT`: "No puedo preparar esta transferencia porque la wallet destino incumple una regla de seguridad."

Cada mensaje debe incluir:

- resumen de la acción,
- nivel de riesgo,
- razones principales,
- acción sugerida: continuar, revisar manualmente o bloquear.

Si existe `agentOpinion`, debe presentarse aparte del bloque principal de riesgo, con un rótulo equivalente a "Opinión adicional del asistente" o similar. Solo aplica a propuestas `ALLOW` o `WARN`; una decisión `REJECT` se comunica con el bloqueo determinístico sin opinión LLM adicional.

## 9. Códigos mínimos auditables

- `RECIPIENT_NOT_INDEXED_ON_SOLSCAN`: la wallet no apareció indexada o no aportó evidencia suficiente en Solscan.
- `PROVIDER_PARTIAL_FAILURE`: uno o más proveedores secundarios fallaron; para este addendum debe cubrir explícitamente errores operativos de Solscan.

## 10. Contrato funcional de `agentOpinion`

```ts
risk.walletSafety.agentOpinion?: {
  summary: string;
  basedOn: {
    codes: string[];
    sources: Array<{
      provider: string;
      status: string;
    }>;
  };
  model?: string;
  generatedAt: string;
};
```

Reglas funcionales:

- `summary` debe ser breve, legible por usuario y no alarmista.
- `basedOn.codes` solo puede listar códigos ya presentes en el análisis determinístico.
- `basedOn.sources` solo puede listar proveedores efectivamente consultados o marcados en `providerStatuses`.
- `model` es opcional, queda reservado para auditoría/debug y no debe mostrarse en la UI.
- `generatedAt` debe registrar timestamp de generación.

## 11. Riesgos funcionales principales

- Falsos positivos sobre wallets nuevas pero legítimas.
- Dependencia parcial de proveedores externos para reputación.
- Cobertura parcial o latencia de Solscan para cuentas nuevas, poco usadas o no indexadas todavía.
- Confusión del usuario si la UI no diferencia claramente `WARN` de `REJECT`.
- Divergencia entre el análisis off-chain y lo verificable on-chain si no se fija bien el `action_hash`.
- La opinión LLM podría sonar demasiado concluyente si la UI no la presenta como secundaria y opcional.
