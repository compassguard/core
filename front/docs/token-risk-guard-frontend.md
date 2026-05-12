# Token Risk Guard - Frontend

## Proposito

Este documento define las responsabilidades del frontend para Token Risk Guard. La UI debe presentar una preview verificable del swap y del riesgo antes de cualquier aprobacion, y debe ser el unico punto donde Phantom solicita firmas de la wallet del usuario.

## Limites de responsabilidad

El frontend debe:

- Detectar y conectar Phantom para obtener `userWallet`.
- Enviar al backend la intencion del usuario o del agente sin entregar claves privadas.
- Mostrar quote, score, decision, warnings, reject reasons, fuentes usadas, `providerMode` y expiracion.
- Gestionar el flujo de firma con Phantom cuando la accion sea aprobable.
- Enviar al backend/RPC la aprobacion o transaccion firmada segun el flujo elegido.
- Reflejar estados recibidos por API/SSE hasta cierre, expiracion o error.

El frontend no debe:

- Usar embedded wallet para sustituir Phantom.
- Custodiar claves privadas.
- Permitir que el backend firme por la wallet del usuario.
- Tratar una aprobacion del agente como aprobacion de la wallet.
- Ocultar warnings severos detras de una accion automatica.
- Abrir Phantom si la accion esta en `hard reject`.

Clarificacion clave: cualquier firma de Phantom ocurre en frontend. El backend nunca firma por `userWallet`.

## Preview UI

Antes de solicitar firma, la UI debe mostrar:

- Token origen, token destino, monto de entrada y minimo esperado de salida.
- Quote provider, `quoteId` cuando exista, `priceImpactPct`, `slippageBps`, ruta resumida y `quoteHash`.
- `riskScore`, `maxAllowedRiskScore`, `decision`, severidad visual y `riskReportHash`.
- Warnings y razones de rechazo con codigo, severidad, mensaje y evidencia resumida.
- `providerMode`: `"live"`, `"mock"` o `"mixed"`.
- Fuentes consultadas y estado: `ok`, `missing`, `stale` o `error`.
- Expiracion del quote/reporte y estado de frescura.
- Accion primaria coherente: conectar wallet, revisar, firmar con Phantom, bloqueado o esperar.

Si la decision es `WARN`, la UI debe requerir confirmacion explicita de warnings antes de abrir Phantom cuando `warningAcknowledgementRequired` sea verdadero.

Si la decision es `REJECT` o `hardReject = true`, la UI debe bloquear la firma y mostrar las razones.

## Flujo Phantom

El flujo esperado es:

1. Usuario conecta Phantom desde el frontend.
2. Frontend solicita preview al backend con la intencion y `userWallet`.
3. Backend responde una accion pendiente y metadata para UI.
4. Usuario revisa quote y riesgo.
5. Si la accion es aprobable, frontend llama a Phantom para firmar mensaje o transaccion.
6. Si el usuario cancela, la UI registra rechazo/cancelacion y no ejecuta.
7. Si el usuario firma, el frontend envia la firma o transaccion firmada al backend/RPC.
8. UI sigue estados por API/SSE hasta `confirmed`, `failed`, `blocked` o `expired`.

La UI debe invalidar la accion si cambian parametros criticos visibles despues del preview: monto, mints, slippage, quote, ruta, expiracion, `riskReportHash` o `policyVersion`.

## Estados de UI

Estados consumidos:

- `pending`: accion creada, aun sin decision final visible o esperando preview.
- `needs_user_signature`: preview listo y Phantom requerido.
- `blocked`: hard reject o validacion bloqueada.
- `approved_by_user`: usuario firmo en Phantom.
- `submitted`: transaccion enviada.
- `confirmed`: ejecucion confirmada.
- `failed`: error de firma, envio, backend, RPC u on-chain.
- `expired`: quote/reporte vencido.

La UI debe evitar dobles envios mientras el estado sea `approved_by_user` o `submitted`.

## Metadata API/SSE consumida

```ts
type RiskDecision = "APPROVE" | "WARN" | "REJECT";

type RiskReason = {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  evidence?: Record<string, unknown>;
};

type RiskSource = {
  name: "jupiter" | "birdeye" | "helius" | "solana-rpc" | "internal-list" | "mock";
  status: "ok" | "missing" | "stale" | "error";
  fetchedAt?: string;
  detailsHash?: string;
};

type SwapRiskPreviewEvent = {
  type: "swap_risk_preview";
  actionId: string;
  status:
    | "pending"
    | "needs_user_signature"
    | "blocked"
    | "approved_by_user"
    | "submitted"
    | "confirmed"
    | "failed"
    | "expired";
  userWallet: string;
  providerMode: "live" | "mock" | "mixed";
  sources: RiskSource[];
  quote: {
    provider: "jupiter" | "mock";
    quoteId?: string;
    inAmount: string;
    outAmount: string;
    minOutAmount: string;
    priceImpactPct?: number;
    routePlanHash: string;
    quoteHash: string;
    rawQuoteRef?: string;
  };
  riskSummary: {
    decision: RiskDecision;
    riskScore: number;
    maxAllowedRiskScore: number;
    label: "low" | "medium" | "high" | "blocked";
    warnings: RiskReason[];
    rejectReasons: RiskReason[];
    riskReportHash: string;
    policyVersion: string;
    expiresAt: string;
  };
  phantom: {
    required: boolean;
    messageToSign?: string;
    transactionToSignBase64?: string;
  };
  ui: {
    primaryAction: "connect_wallet" | "review" | "sign_with_phantom" | "blocked" | "wait";
    bannerTone: "neutral" | "warning" | "danger" | "success";
    warningAcknowledgementRequired: boolean;
  };
};
```

## Aceptacion frontend

- La UI conecta solo Phantom para la wallet del usuario.
- No existe embedded wallet ni custodia de claves.
- Ningun flujo permite que backend firme por `userWallet`.
- La preview muestra quote, score, decision, warnings/reject reasons, fuentes, `providerMode`, expiracion y hashes relevantes.
- `REJECT` bloquea la apertura de Phantom.
- `WARN` muestra confirmacion explicita cuando corresponde.
- El usuario puede cancelar Phantom sin ejecutar nada.
- Estados API/SSE se reflejan sin permitir doble submit.
- La UI distingue fuentes live, mock y mixed para demo.

## Casos demo frontend

1. **Token allowlisted y liquido**: preview muestra `APPROVE`, fuentes `ok`, boton de Phantom habilitado y estado final `confirmed`.
2. **Token nuevo con baja liquidez**: preview muestra `WARN` o `REJECT`; si es `WARN`, requiere acknowledgement antes de Phantom.
3. **Token con freeze authority activa**: UI muestra `REJECT`, razones criticas y no abre Phantom.
4. **Quote expirado**: UI pasa a `expired`, deshabilita firma y solicita regenerar preview.
5. **Usuario cancela Phantom**: UI queda en estado fallido/cancelado sin enviar transaccion.
6. **Proveedor mock en demo**: UI muestra `providerMode: "mock"` o `"mixed"` y fuentes mock/missing sin presentarlas como live.
