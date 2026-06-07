# Token Risk Guard - Backend y On-chain

## Proposito

Este documento define responsabilidades backend/off-chain y on-chain para Token Risk Guard. El backend calcula riesgo y firma reportes canonicos como oracle autorizado; el programa `AgentActionGuard` valida hechos deterministicos y nunca calcula senales dinamicas de mercado.

## Separacion critica

- **Off-chain risk engine**: calcula liquidez, ruta, holders, reputacion, volumen, volatilidad, price impact, slippage requerido, edad de token/pool, blocklists y allowlists.
- **On-chain `AgentActionGuard`**: valida identidad, parametros exactos, hashes, firma del oracle/backend, expiracion, politica, umbrales y anti-replay.

El backend puede firmar `TokenRiskReport` o su hash con una clave oracle/backend autorizada. Nunca firma transacciones ni aprobaciones por la wallet del usuario.

## Responsabilidades backend/off-chain

El backend debe:

- Parsear la intencion del usuario/agente: `inputMint`, `outputMint`, monto, slippage maximo, restricciones y contexto.
- Obtener quote de swap y metadata de ruta.
- Obtener datos de riesgo desde proveedores disponibles.
- Calcular indicadores de riesgo con politica versionada.
- Calcular `riskScore`, `decision`, `warnings`, `rejectReasons` y `hardReject`.
- Generar un `TokenRiskReport` canonico.
- Calcular `quoteHash` y `riskReportHash`.
- Firmar el reporte o hash canonico con `oracleSigner` autorizado.
- Crear y persistir `PendingSwapAction`.
- Exponer API/SSE para preview y seguimiento de estado.
- Registrar audit logs de inputs, fuentes, decision, firmas, errores, expiracion y ejecucion.

Debe evitar:

- Firmar por `userWallet`.
- Recalcular silenciosamente el quote despues del preview sin invalidar hashes.
- Aprobar swaps con reporte expirado, quote vencido o parametros criticos cambiados.

## Senales e indicadores off-chain

Senales recomendadas:

- Liquidez disponible y profundidad cercana al tamano de orden.
- Profundidad y calidad de ruta; dependencia de pools pequenos.
- Holder count y evolucion reciente cuando el proveedor lo exponga.
- Concentracion de holders, deployer, LP, insiders o cuentas nuevas.
- Reputacion, blocklists, allowlists, etiquetas de scam y reportes externos.
- Verificacion/listing en Jupiter u otros proveedores confiables.
- Mint authority y freeze authority.
- Token-2022 extensions: transfer hooks, permanent delegate, confidential transfers, transfer fees u otras extensiones relevantes.
- Volatilidad, caidas abruptas, spikes de bajo volumen y price impact.
- Slippage requerido frente al maximo de politica y del usuario.
- Volumen reciente y senales de wash trading si el proveedor lo permite.
- Edad de token y pool.
- Integridad del quote: ruta, output esperado, fees, proveedores y hashes.

Proveedores posibles:

- **Jupiter**: quote/rutas, verification, metadata, price impact y datos de token disponibles.
- **Birdeye**: liquidez, precio, volumen, holders, velas y metadata de mercado.
- **Helius**: RPC enriquecido, token accounts, historial, metadata y senales derivadas.
- **RPC Solana directo**: mint account, authorities, Token Program/Token-2022 y edad aproximada cuando sea viable.
- **Listas internas**: allowlist, blocklist, overrides y politicas por entorno.

Para demo se aceptan mocks deterministas, pero el contrato debe declarar `providerMode: "live" | "mock" | "mixed"` y enumerar fuentes usadas.

## Politica y scoring

La politica debe ser versionada y auditable. Ejemplo conceptual:

- `riskScore` de 0 a 100.
- `0-30`: bajo, `APPROVE`.
- `31-60`: medio, `WARN`.
- `61-79`: alto, `WARN` con confirmacion explicita o bloqueo segun monto.
- `80-100`: `REJECT`.

La politica puede ajustar umbrales por monto, allowlist, modo demo/produccion, disponibilidad de proveedores y perfil de riesgo del usuario.

## Hard reject y warnings

### Hard reject

El sistema debe bloquear la accion antes de firma o durante validacion si se cumple alguna condicion critica:

- `outputMint` aparece en blocklist interna o externa confiable.
- Mint o deployer asociado a scam/rug confirmado.
- Quote expirado, inconsistente o con `quoteHash` distinto al preview.
- `riskReportHash` no coincide con el reporte firmado.
- Firma del oracle/backend invalida o signer no autorizado.
- Reporte expirado o fuera de freshness window.
- `policyVersion` no permitida.
- Price impact supera el maximo absoluto permitido.
- Slippage requerido supera el maximo de politica o del usuario.
- Liquidez insuficiente para el tamano del swap.
- Holder concentration critica.
- Holder count extremadamente bajo para un token no allowlisted.
- Mint authority o freeze authority activa en un token no allowlisted cuando la politica lo considera critico.
- Token-2022 extension peligrosa o incompatible, como permanent delegate o transfer hook no reconocido.
- Pool/token demasiado nuevo y sin allowlist.
- Replay detectado: `actionId`/nonce ya ejecutado.

### Warning

El sistema puede permitir continuar con aprobacion explicita del usuario si el riesgo es elevado pero no critico:

- Liquidez baja pero suficiente para el monto.
- Volumen reciente bajo o irregular.
- Token no verificado, sin blocklist ni senales criticas.
- Holder count moderadamente bajo.
- Concentracion elevada pero bajo umbral de rechazo.
- Alta volatilidad reciente.
- Pool joven con ruta y liquidez aceptables.
- Falta una fuente secundaria, pero las fuentes criticas responden.
- Price impact alto dentro del limite maximo.

## Contratos backend

```ts
type RiskDecision = "APPROVE" | "WARN" | "REJECT";

type TokenRiskReport = {
  reportId: string;
  actionId: string;
  chainId: "solana-mainnet" | "solana-devnet" | "solana-localnet";
  generatedAt: string;
  expiresAt: string;
  policyVersion: string;
  providerMode: "live" | "mock" | "mixed";
  inputMint: string;
  outputMint: string;
  quoteHash: string;
  riskScore: number;
  maxAllowedRiskScore: number;
  decision: RiskDecision;
  hardReject: boolean;
  warnings: RiskReason[];
  rejectReasons: RiskReason[];
  indicators: {
    liquidityUsd?: number;
    routeDepth?: number;
    holderCount?: number;
    topHolderConcentrationPct?: number;
    verifiedToken?: boolean;
    listedBy?: string[];
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    tokenProgram: "spl-token" | "token-2022" | "unknown";
    token2022Extensions?: string[];
    volatility24hPct?: number;
    priceImpactPct?: number;
    slippageBps?: number;
    volume24hUsd?: number;
    tokenAgeHours?: number;
    poolAgeHours?: number;
    blocklistHits?: string[];
    allowlistHits?: string[];
  };
  sources: RiskSource[];
  canonicalHash: string;
  oracleSigner: string;
  oracleSignature: string;
};

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

type PendingSwapAction = {
  actionId: string;
  userWallet: string;
  agentId?: string;
  status:
    | "pending"
    | "needs_user_signature"
    | "blocked"
    | "approved_by_user"
    | "submitted"
    | "confirmed"
    | "failed"
    | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  intent: {
    inputMint: string;
    outputMint: string;
    amountIn: string;
    maxSlippageBps: number;
  };
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
  risk: {
    reportId: string;
    riskReportHash: string;
    decision: RiskDecision;
    riskScore: number;
    maxAllowedRiskScore: number;
    oracleSigner: string;
    oracleSignature: string;
  };
  frontend: {
    requiresPhantomSignature: boolean;
    previewRequired: boolean;
    warningAcknowledgementRequired: boolean;
  };
  execution?: {
    transactionSignature?: string;
    slot?: number;
    errorCode?: string;
    errorMessage?: string;
  };
  auditLogRef: string;
};
```

## Contrato API/SSE hacia frontend

El backend debe emitir un resumen de preview para UI, sin exponer secretos ni permitir firma backend de usuario:

```ts
type SwapRiskPreviewEvent = {
  type: "swap_risk_preview";
  actionId: string;
  status: PendingSwapAction["status"];
  userWallet: string;
  providerMode: "live" | "mock" | "mixed";
  sources: RiskSource[];
  quote: PendingSwapAction["quote"];
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

## Responsabilidades on-chain: `AgentActionGuard`

`AgentActionGuard` debe verificar:

- `userSigner`: la wallet que autoriza coincide con la accion pendiente.
- Parametros exactos del swap: `inputMint`, `outputMint`, `amountIn`, `minAmountOut`, `slippageBps`, `routePlanHash` o equivalente.
- `quoteHash`: hash del quote canonico que el usuario vio.
- `riskReportHash`: hash del reporte de riesgo canonico.
- Signer autorizado del reporte: `riskOracle` o backend signer incluido en allowlist on-chain.
- Validez criptografica de la firma del reporte.
- `expiresAt` / slot maximo / freshness window.
- `policyVersion` permitido.
- `decision` y umbral: por ejemplo `APPROVE` o `WARN` aceptado con `riskScore <= maxAllowedRiskScore`.
- Anti-replay: `actionId` no ejecutado previamente, nonce valido o PDA marcada como consumida.
- Estado de ejecucion atomico: aprobado, bloqueado o consumido.

No debe:

- Hacer llamadas HTTP.
- Leer APIs externas.
- Iterar holders.
- Calcular liquidez de DEXs.
- Inferir reputacion desde listas grandes.

### Campos on-chain de aprobacion

```ts
type AgentActionGuardApproval = {
  actionId: string;
  userSigner: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  minAmountOut: string;
  slippageBps: number;
  routePlanHash: string;
  quoteHash: string;
  riskReportHash: string;
  policyVersion: string;
  decision: "APPROVE" | "WARN";
  riskScore: number;
  maxAllowedRiskScore: number;
  expiresAtSlot?: bigint;
  expiresAtUnix?: bigint;
  oracleSigner: string;
  oracleSignature: string;
  nonce: string;
};
```

## Auditoria

Cada accion debe registrar:

- Intencion original.
- Wallet del usuario.
- Quote canonico y hash.
- Reporte de riesgo canonico y hash.
- Fuentes consultadas y estado.
- Decision, score, policy version y razones.
- Firma del oracle/backend.
- Eventos relevantes reportados por frontend: preview mostrado, warnings acknowledged, Phantom aprobado/rechazado.
- Resultado on-chain: aprobado, bloqueado, tx signature, slot y error si aplica.

## Aceptacion backend/on-chain

- El backend evalua riesgo off-chain antes de que el usuario firme.
- El backend nunca firma por la wallet del usuario.
- `TokenRiskReport` y `PendingSwapAction` incluyen hashes, decision, score, fuentes, politica y firma oracle/backend.
- Existen reglas claras de `hard reject` y `warning`.
- La respuesta API/SSE contiene metadata suficiente para preview frontend.
- `AgentActionGuard` valida hashes, firma, signer autorizado, expiracion, politica, umbrales, parametros exactos y anti-replay.
- Liquidez, holders, reputacion, volumen, volatilidad y proveedores quedan explicitamente fuera del calculo on-chain.
- La decision final queda auditable con `policyVersion`, `riskReportHash`, `quoteHash` y `oracleSignature`.

## Casos demo backend/on-chain

1. **Token allowlisted y liquido**: quote estable, senales sanas, `APPROVE`, reporte firmado y guard on-chain permite ejecucion.
2. **Token nuevo con baja liquidez**: score alto; backend emite `WARN` o `REJECT` segun monto y politica.
3. **Token con freeze authority activa**: backend emite `REJECT` si la politica lo marca critico.
4. **Token-2022 con extension incompatible**: backend emite `REJECT`; on-chain no necesita calcular la extension, solo valida el reporte firmado.
5. **Quote alterado despues del preview**: guard rechaza por mismatch de `quoteHash`, `routePlanHash` o parametros exactos.
6. **Reporte expirado**: guard rechaza por freshness/expiration.
7. **Replay de accion**: segunda ejecucion del mismo `actionId`/nonce queda bloqueada.
8. **Proveedor live no disponible en demo**: backend declara `providerMode: "mock"` o `"mixed"` y aplica politica de demo auditable.
