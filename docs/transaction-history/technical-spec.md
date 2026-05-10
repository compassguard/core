# Technical Spec - Public Transaction History With Umbra-Aware Privacy Boundary

Version: 1
Status: Planned
Date: 2026-05-09
Source: user request + explorer handoff + verified Umbra context

## Arquitectura propuesta

La implementacion se divide en dos capas funcionales:

1. `Public history domain`
2. `Private Umbra history domain`

Phase 1 implementa solo el dominio publico. Phase 2 agrega el dominio privado sin cambiar el contrato base del historial publico.

## Dominio publico

Flujo tecnico propuesto:

1. `FRONT/src/hooks/useTransactionHistory.ts` consulta el backend cuando la tab `History` esta activa.
2. `FRONT/src/lib/api/client.ts` envia `address`, `limit` y `before`.
3. `app/api/wallet/transactions/route.ts` valida query params y delega en un servicio backend.
4. El servicio backend consulta un proveedor publico compatible con Solana RPC o el patron existente tipo Helius proxy.
5. El backend normaliza el resultado a `GetTransactionsResponseSchema`.
6. La UI renderiza items y usa `next_cursor` para pedir mas paginas.

## Dominio privado Umbra

No se implementa en esta fase, pero el contrato funcional queda fijado:

- la actividad privada no debe salir por el endpoint publico generico
- cualquier vista privada requiere consentimiento explicito
- la app puede mostrar solo estados seguros y no sensibles cuando todavia no hay decryption autorizada
- viewing grants y compliance access son opt-in y su revocacion no borra datos ya compartidos

## Modelo de datos de Phase 1

Se reutiliza el contrato existente:

```ts
type TxHistoryItem = {
  tx_hash: string;
  type: 'swap' | 'transfer' | 'stake' | 'other';
  status: 'success' | 'failed';
  timestamp: string;
  summary: string;
  amount?: number;
  amount_symbol?: string;
  amount_usd?: number;
  explorer_url: string;
};

type GetTransactionsResponse = {
  transactions: TxHistoryItem[];
  next_cursor?: string;
};
```

Normalizacion minima recomendada para demo_fast:

- `type`: `other` cuando no haya clasificacion confiable
- `status`: `success` o `failed`
- `timestamp`: ISO string
- `summary`: breve y segura, derivada de datos publicos
- `amount` + `amount_symbol`: opcionales; en Phase 1 representan el cambio neto publico de SOL para la wallet cuando `getTransaction` devuelve balances suficientes
- `explorer_url`: URL a Solana Explorer por signature

## Contrato HTTP

`GET /api/wallet/transactions`

Query params:

- `address`: requerido
- `limit`: opcional, entero positivo con maximo defensivo
- `before`: opcional, cursor de paginacion

Respuesta exitosa:

```json
{
  "transactions": [
    {
      "tx_hash": "signature",
      "type": "other",
      "status": "success",
      "timestamp": "2026-05-09T12:00:00.000Z",
      "summary": "Public Solana transaction",
      "amount": -0.001,
      "amount_symbol": "SOL",
      "explorer_url": "https://explorer.solana.com/tx/signature"
    }
  ],
  "next_cursor": "older-signature"
}
```

Errores esperados:

- `400 invalid_payload` si falta `address` o params invalidos
- `502 provider_error` si el proveedor falla
- `503 provider_not_configured` si falta configuracion obligatoria

## Componentes a modificar

- `app/api/wallet/transactions/route.ts`
  Reemplazar stub/mock por validacion real y llamada a servicio backend.

- `BACK/services/*`
  Agregar o extender un servicio de historial publico siguiendo el patron de integraciones backend.

- `FRONT/src/hooks/useTransactionHistory.ts`
  Incluir cursor en query key y soporte para cargar paginas adicionales.

- `FRONT/src/lib/api/client.ts`
  Confirmar serializacion de `limit` y `before`.

- `FRONT/src/components/layout/DesktopShell.tsx`
  Mejorar `HistoryView` para loading, error, empty, lista, explorer link y cargar mas.

## Provider strategy

Phase 1 debe usar una estrategia backend-managed y no consultar RPC directamente desde el navegador.

Opciones validas dentro del alcance:

- Solana RPC estandar via backend
- proxy a Helius o proveedor equivalente, siguiendo el patron ya presente en `BACK/services/helius.ts`

Decision de esta spec:

- el contrato del frontend queda provider-agnostic
- la implementacion puede elegir la ruta mas simple y estable en el worktree actual
- la respuesta debe mantenerse en el schema existente aunque el proveedor cambie

## Reglas de privacidad y guardrails

- El endpoint publico nunca debe exponer datos privados de Umbra.
- Si una transaccion Umbra deja una huella publica on-chain, Phase 1 puede mostrar solo la parte publica visible.
- No se deben inferir ni decorar counterparties privadas, montos shielded ni notas internas en la vista publica.
- Si en el futuro existe vista privada Umbra, debe requerir consentimiento explicito y una fuente de datos autorizada.
- No debe haber decryption silenciosa al abrir `History`.

## Phase 2 contract boundary

La futura integracion Umbra debe modelarse como una fuente separada, por ejemplo:

```ts
type PrivateHistoryAvailability = {
  registration_state: 'not_registered' | 'registered' | 'unknown';
  consent_state: 'not_granted' | 'granted';
  viewing_grants: 'none' | 'active';
};
```

Y una clase de eventos privada separada del feed publico:

```ts
type UmbraPrivateHistoryItem = {
  id: string;
  kind: 'deposit' | 'withdraw' | 'claim' | 'shielded_transfer';
  status: 'pending' | 'completed' | 'failed';
  timestamp: string;
  visibility: 'private';
  redacted_summary: string;
};
```

Estos tipos son contractuales para la fase futura; no obligan a instalar el SDK ahora.

## Riesgos

- El proveedor publico puede devolver metadata inconsistente o insuficiente para clasificar tipos con precision; por eso `other` debe seguir siendo valido.
- La paginacion por cursor puede variar segun el proveedor; el backend debe encapsular esa variacion.
- Una UI unica de historial puede inducir a error si no deja claro que Phase 1 solo cubre actividad publica.
- Integrar Umbra sin boundary claro podria filtrar datos privados en resumentes genericos.

## Verificacion

- Probar que `History` deja de usar mock y devuelve datos reales para una wallet valida.
- Probar `400` para requests sin `address`.
- Probar que `next_cursor` aparece solo cuando existe una pagina siguiente.
- Probar estados de loading, empty y error en UI.
- Probar que la UI muestra copy de privacidad indicando que Umbra private history no esta activa en Phase 1.
- Verificar que el endpoint publico no agrega campos privados ni intenta decrypt por defecto.
