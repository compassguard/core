# Especificación Funcional — Contextual Guardrail Explanations

**Versión:** 0.1  
**Fecha:** 2026-05-12  
**Estado:** Draft para revisión  
**Feature:** `contextual-guardrail-explanations`

## 1. Objetivo

Agregar explicaciones contextuales y progresivas a los guardrails de la app para que el usuario entienda qué está evaluando el sistema, por qué una acción se permite/advierte/bloquea y qué puede hacer a continuación.

La experiencia debe enseñar en el momento justo, sin transformar cada operación en una clase larga ni aumentar la fatiga de warnings.

## 2. Problema a resolver

El producto ya tiene guardrails fuertes y algunas explicaciones visibles, especialmente en transferencias. Sin embargo, la experiencia actual es inconsistente:

- Las transferencias tienen explicaciones ricas vía `RiskInlineAlert`.
- Los swaps tienen warning/bypass copy, pero no comparten una taxonomía común con transferencias.
- Las órdenes condicionales muestran datos operativos, pero tienen menos explicación educativa.
- El agente puede narrar, pero no existe un contrato único que defina la explicación oficial de una decisión de guardrail.
- Parte de la explicación vive hardcodeada en frontend, lo que puede divergir de la lógica real del backend.

El usuario necesita entender:

1. Qué acción se está por ejecutar.
2. Qué revisó el guardrail.
3. Qué decisión tomó: permitir, advertir o bloquear.
4. Por qué esa decisión importa.
5. Qué opciones seguras tiene ahora.

## 3. Principios de producto

### 3.1 Backend como fuente de verdad

La razón oficial de una decisión de seguridad debe venir del backend/rules engine, porque ahí se calculan los hechos del guardrail.

El frontend no debe inventar razones de seguridad. Puede traducir, ordenar y presentar razones, pero no crear causalidad nueva.

### 3.2 Frontend como capa de aprendizaje progresivo

La UI debe mostrar la explicación en niveles:

1. **Resumen:** veredicto corto y accionable.
2. **Por qué:** razones humanas y consecuencia práctica.
3. **Detalle técnico:** checks, fuentes, estado de proveedores, datos on-chain y hashes.

### 3.3 Agente como narrador, no decisor

El agente puede explicar en lenguaje natural, pero solo debe parafrasear payloads estructurados del backend.

El agente no puede originar una decisión de guardrail ni inventar checks no ejecutados.

### 3.4 Just-in-time learning

La enseñanza debe aparecer en el momento de decisión:

- antes de firmar;
- al mostrar una advertencia;
- al bloquear una acción;
- al ofrecer bypass o confirmación reforzada;
- al monitorear una condición recurrente.

No se requiere un tutorial separado para el MVP.

## 4. Alcance por fases

## Fase 1 — Explanation payload incremental

### Objetivo

Introducir un modelo estructurado y opcional de explicación, emitido por backend y consumido por frontend, sin reescribir todo el sistema de propuestas.

### Flujos cubiertos

- Transferencia SOL/SPL soportada por el flujo actual.
- Swap Orca protegido por guard de precio.
- Guard rejection/bypass de swap.

### Comportamiento esperado

Para cada acción crítica protegida por guardrail, el backend puede adjuntar un payload `explanation` con:

- veredicto;
- severidad;
- resumen;
- razones normalizadas;
- checks ejecutados;
- fuentes consultadas;
- acción sugerida.

La UI debe poder mostrar ese payload sin romper clientes si el campo no existe.

### Resultado funcional

- El usuario ve un resumen consistente de por qué una acción fue permitida, advertida o bloqueada.
- La explicación se mantiene atada a la decisión real del guardrail.
- Los componentes actuales pueden seguir funcionando con fallback a la copy existente.

## Fase 2 — Shared explanation UI y taxonomía común

### Objetivo

Unificar la presentación de explicaciones en una experiencia reusable para transferencias, swaps y órdenes condicionales.

### Flujos cubiertos

- Transferencias.
- Swaps.
- Conditional buy SOL.
- Estados de guardrail `ALLOW`, `WARN`, `REJECT`.

### Comportamiento esperado

La UI debe ofrecer disclosure progresivo:

1. **Card resumida:** decisión, severidad, razón principal y siguiente acción.
2. **Panel “Por qué”:** lista de razones humanas y consecuencias.
3. **Panel técnico:** checks, fuentes, timestamps, action hash, PDAs, oráculos y metadata relevante.

La taxonomía de riesgo debe ser común:

- `destination_trust`
- `token_or_protocol_safety`
- `price_or_execution_risk`
- `permission_scope`
- `user_policy`
- `network_or_provider_state`
- `onchain_enforcement`

### Resultado funcional

- El usuario aprende el mismo vocabulario de riesgo en todos los flujos.
- La UI reduce copy duplicada y evita divergencias entre componentes.
- Los detalles técnicos quedan disponibles sin saturar el flujo principal.

## Fase 3 — Agent narrative constrained by explanation payload

### Objetivo

Permitir que el agente explique de forma conversacional qué está pasando, usando únicamente los hechos estructurados del guardrail.

### Flujos cubiertos

- Mensajes de propuesta.
- Mensajes de warning.
- Mensajes de bloqueo.
- Bypass de swap.
- Estado de órdenes condicionales cuando haya motivos observables.

### Comportamiento esperado

El agente puede generar micro-explicaciones como:

> “Te estoy pidiendo una revisión extra porque el destino no está en tu allowlist y el monto supera tu umbral de precaución.”

Pero la narrativa debe estar limitada por:

- `explanation.reason_codes`
- `explanation.reasons`
- `explanation.checks`
- `explanation.sources`
- `explanation.suggested_user_action`

Si no hay payload estructurado suficiente, el agente debe usar copy genérica segura o no agregar explicación narrativa.

### Resultado funcional

- El chat se siente más pedagógico.
- La explicación no contradice el guardrail determinístico.
- Se puede ajustar el tono sin tocar la lógica de seguridad.

## 5. Modelo de explicación funcional

Cada explicación debe responder, cuando corresponda:

1. **Veredicto:** ¿Se puede continuar?
2. **Por qué:** ¿Qué señales importan?
3. **Impacto:** ¿Qué podría pasar si el usuario ignora el warning?
4. **Siguiente paso:** ¿Qué opción segura tiene?
5. **Evidencia:** ¿Qué se chequeó y con qué fuente?

Plantilla funcional recomendada:

```text
Veredicto: Necesita revisión
Por qué: La wallet destino no está en tu allowlist y el monto supera tu umbral.
Impacto: Si la dirección está mal o pertenece a un tercero, los fondos pueden perderse.
Siguiente paso: Cancelá, verificá la dirección por otro canal o enviá un monto menor.
```

## 6. Requerimientos funcionales

### RF-1: Explicación estructurada opcional

El backend debe poder adjuntar una explicación estructurada a respuestas de guardrail sin hacer obligatorio el campo para clientes existentes.

### RF-2: Decisión visible y consistente

La UI debe mostrar la decisión del guardrail con labels consistentes:

- `Permitido`
- `Revisá antes de firmar`
- `Bloqueado por seguridad`

### RF-3: Razones específicas

Las explicaciones deben priorizar razones concretas sobre scores genéricos.

Correcto:

> “La wallet destino no está en tu allowlist y el monto supera tu umbral de precaución.”

Incorrecto:

> “Riesgo 72/100.”

### RF-4: Acción sugerida

Toda explicación `WARN` o `REJECT` debe incluir al menos una acción sugerida:

- continuar;
- cancelar;
- reducir monto;
- verificar destino;
- enviar monto de prueba;
- revisar slippage/precio;
- esperar y reintentar;
- contactar soporte o segundo aprobador, si existe.

### RF-5: Disclosure progresivo

La UI debe mostrar resumen primero y detalles técnicos bajo interacción explícita.

### RF-6: Diferenciar enforcement off-chain y on-chain

La explicación debe distinguir entre:

- validación backend;
- consulta externa;
- simulación/cotización;
- enforcement on-chain;
- verificación del wallet provider.

### RF-7: No bloquear por falla narrativa

Si falla la generación narrativa del agente, la operación no debe cambiar su decisión. La decisión determinística sigue siendo válida.

### RF-8: No inventar checks

Ninguna explicación puede afirmar que se ejecutó un check que no aparece en el payload estructurado.

### RF-9: Soporte de idioma inicial

El MVP debe usar español rioplatense/neutro consistente con el resto de la UI actual. El contrato debe permitir futura i18n por `code`.

### RF-10: Compatibilidad con historial

Las propuestas guardadas en historial deben poder renderizarse aunque no tengan `explanation`.

## 7. Casos de uso

### CU-1: Transferencia segura

1. Usuario pide enviar SOL a una wallet.
2. Backend valida destino, política y guard on-chain.
3. Decisión `ALLOW`.
4. UI muestra “Riesgo bajo” y permite expandir “Chequeos realizados”.
5. Usuario entiende que el sistema validó dirección, listas y guardrail antes de firmar.

### CU-2: Transferencia con warning

1. Usuario intenta enviar un monto alto a wallet no allowlisted.
2. Backend decide `WARN`.
3. UI muestra “Revisá antes de firmar”.
4. Detalle explica que el destino no está allowlisted y el monto supera el umbral.
5. UI sugiere verificar dirección o enviar monto menor.

### CU-3: Transferencia bloqueada

1. Usuario intenta enviar a una cuenta ejecutable o bloqueada.
2. Backend decide `REJECT`.
3. No se genera transacción firmable.
4. UI/chat explican el motivo y sugieren corregir destino.

### CU-4: Swap con desviación de precio

1. Usuario aprueba swap.
2. Guard compara cotización contra oráculo.
3. Si hay desviación moderada, UI muestra warning con impacto.
4. Si hay rechazo bypassable, UI muestra la diferencia entre ejecutar protegido y ejecutar sin protección.

### CU-5: Orden condicional no ejecutable

1. Usuario crea una condición recurrente.
2. El sistema monitorea precio/ventana/estado de red.
3. Si todavía no se ejecuta, UI puede explicar: “No se ejecutó porque SOL aún no bajó al precio objetivo”.
4. Si se bloquea por riesgo, muestra razón y siguiente acción.

## 8. Fuera de alcance

- Personalización avanzada por perfil educativo del usuario.
- Tutorial completo separado del flujo transaccional.
- Nuevo motor LLM autónomo que decida seguridad.
- Cambios al programa on-chain para reputación dinámica.
- Integración de nuevos proveedores externos de reputación en esta spec.
- Métricas/product analytics obligatorias en fase 1, aunque se recomiendan para fases posteriores.

## 9. Criterios de aceptación generales

- Las specs viven en `docs/contextual-guardrail-explanations/`.
- Cada fase queda documentada con alcance, no-goals y aceptación.
- El contrato de explicación es backward-compatible.
- Transfer, swap y conditional buy tienen una ruta clara hacia la misma taxonomía.
- El backend permanece como fuente de verdad para hechos de seguridad.
- El agente solo narra hechos presentes en el payload estructurado.
- La UI evita walls of text y usa disclosure progresivo.

## 10. Riesgos funcionales

- **Fatiga de warnings:** demasiada explicación puede hacer que el usuario ignore todo.
- **Doble verdad:** frontend y backend pueden divergir si la UI mantiene demasiada lógica propia.
- **Exceso técnico:** mostrar hashes/program IDs por defecto puede confundir usuarios nuevos.
- **Falsa certeza:** decir “seguro” cuando en realidad significa “sin señales conocidas”.
- **Bypass mal entendido:** ejecutar sin protección debe tener lenguaje fuerte y explícito.

## 11. Métricas recomendadas para futuro

- Tasa de expansión de detalles.
- Tasa de cancelación después de `WARN`.
- Tasa de bypass después de guard rejection.
- Tiempo hasta firma.
- Razones más frecuentes por flujo.
- Warnings ignorados repetidamente.
