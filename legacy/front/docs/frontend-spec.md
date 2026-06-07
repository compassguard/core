# Frontend Spec — Wallet Copilot

**Estado:** SSoT activo.  
**Para qué sirve:** define la arquitectura y decisiones canónicas del frontend.  
**Historia:** reemplaza docs anteriores de risk engine/providers en cliente; si hay contradicción, este documento gana.

Spec del frontend para el proyecto Compass. Cubre estructura, wallet layer, componentes, estados y plan de fases.

---

## 0. Decisiones ya tomadas

| Tema | Decisión |
|---|---|
| Framework | Next.js 14+ App Router (fullstack en Vercel) |
| Lenguaje | TypeScript |
| UI | Tailwind CSS + shadcn/ui |
| Wallet | Phantom Browser Extension / injected provider |
| Auth | Conexión directa con Phantom |
| Custodia | Self-custodial vía Phantom |
| Modelo de operación | Híbrido: agent autónomo bajo threshold, confirmación manual sobre threshold |
| Recovery | Login con Google + opción de exportar seed key en Settings |
| Chain | Solana (mainnet) — multichain queda fuera de scope para hackathon |
| Estructura repo | `front/src/` para todo el código de UI, consumido desde `app/page.tsx` |
| **Transacciones** | **El backend/agent interpreta intención, aplica risk checks y prepara unsigned transactions; el frontend firma/envía esas transacciones con Phantom injected.** |

---

## 1. Stack y dependencias

```bash
# Core
next                     # App Router
react react-dom
typescript

# UI
tailwindcss
@radix-ui/* (vía shadcn)
lucide-react             # Iconos
class-variance-authority
clsx
tailwind-merge

# Wallet
window.phantom.solana    # Phantom injected provider: connect + signAndSendTransaction

# Estado y data fetching
zustand                  # Estado global liviano
@tanstack/react-query    # Data fetching + cache para /api/*

# Charts
recharts                 # Donut de asset allocation

# Utilidades
zod                      # Validación de payloads de chat
date-fns                 # Timestamps de mensajes
```

**Por qué Zustand y no Context:** el wallet state, chat history y balances cambian a distinto ritmo. Context fuerza re-renders globales; Zustand permite suscribirse a slices puntuales.

**Por qué React Query:** las respuestas de los endpoints propios (`/api/wallet/*`, `/api/agent/*`, `/api/network/*`, `/api/prices`) necesitan cache, revalidación y retry. El frontend no consume Jupiter, Helius, Birdeye ni RPC de Solana directamente; esos providers viven detrás del backend/agent.

---

## 2. Estructura de carpetas (en `front/src/`)

```
front/src/
├── App.tsx                          # Entry, exportado a app/page.tsx
├── providers/
│   ├── PhantomProvider.tsx          # Wrapper del provider injected
│   ├── QueryProvider.tsx            # React Query
│   └── ThemeProvider.tsx
├── components/
│   ├── ui/                          # shadcn primitives (button, card, input, etc.)
│   ├── layout/
│   │   ├── AppShell.tsx             # Container responsive (decide mobile vs desktop)
│   │   ├── DesktopShell.tsx         # 3 columnas
│   │   ├── MobileShell.tsx          # Stack vertical
│   │   ├── TopBar.tsx               # Balance + tabs
│   │   └── BottomNav.tsx            # Solo mobile
│   ├── wallet/
│   │   ├── ConnectButton.tsx
│   │   ├── BalanceCard.tsx
│   │   ├── AssetChip.tsx            # SOL 125 / USDC 2,500 / JUP 420
│   │   └── AssetAllocationDonut.tsx
│   ├── sidebar/
│   │   ├── AccountCard.tsx          # Verified Account + Premium badge
│   │   ├── ChatHistoryList.tsx
│   │   └── QuickActionsList.tsx
│   ├── chat/
│   │   ├── ChatContainer.tsx
│   │   ├── MessageList.tsx
│   │   ├── UserMessage.tsx
│   │   ├── AgentMessage.tsx
│   │   ├── ChatInput.tsx
│   │   ├── proposals/
│   │   │   ├── SwapProposalCard.tsx
│   │   │   └── SendProposalCard.tsx
│   │   └── alerts/
│   │       ├── GasCongestionAlert.tsx
│   │       └── RiskAlert.tsx
│   └── status/
│       ├── ConnectionStatus.tsx     # Mainnet Connected / Latency
│       └── NotificationBell.tsx
├── hooks/
│   ├── useWallet.ts                 # Wrapper Phantom injected + balance polling
│   ├── useChatStore.ts              # Zustand store de chat
│   ├── useAgentMessage.ts           # POST único → /api/chat
│   ├── useWalletBalances.ts         # React Query → /api/wallet/balances
│   ├── useTransactionHistory.ts     # React Query → /api/wallet/transactions
│   └── useAutoConfirmThreshold.ts
├── lib/
│   ├── phantom/
│   │   └── config.ts                # PhantomProvider config
│   ├── format.ts                    # Formato de amounts, addresses (display only)
│   ├── chat/
│   │   └── messageTypes.ts          # Discriminated union de mensajes
│   ├── api/
│   │   ├── client.ts                # Cliente de endpoints propios /api/*
│   │   └── schemas.ts               # Zod schemas
│   └── utils.ts                     # cn() helper para Tailwind
├── stores/
│   └── chatStore.ts                 # Zustand: messages, activeProposal, status
├── types/
│   ├── wallet.ts
│   ├── chat.ts
│   └── api.ts
└── styles/
    └── globals.css                  # Tailwind base + tokens custom
```

---

## 3. Wallet layer — Phantom injected

> ⚠️ **El frontend firma y envía solo transacciones unsigned preparadas por el backend.** El agent/backend interpreta la intención, aplica guardrails, consulta providers y construye la transacción canónica. El frontend no calcula riesgo ni consulta providers externos.

### 3.1 Lo que el SDK te resuelve solo

- Conexión con la cuenta Phantom del usuario.
- Exposición de la public key conectada.
- Firma y envío con `signAndSendTransaction` para unsigned transactions preparadas por backend.
- Eventos de conexión, desconexión y cambio de cuenta.

### 3.2 Setup base

```tsx
// front/src/types/phantom.ts
export function getPhantomProvider() {
  return window.phantom?.solana?.isPhantom ? window.phantom.solana : undefined;
}
```

### 3.3 Hook unificado

```tsx
// front/src/hooks/useWallet.ts
export function useWallet() {
  const provider = getPhantomProvider();
  const address = provider?.publicKey?.toBase58();

  // Balances vienen del backend (el agent los lee y nos los pasa)
  const { data: balances } = useQuery({
    queryKey: ['balances', address],
    queryFn: () => fetch(`/api/wallet/balances?address=${address}`).then(r => r.json()),
    enabled: !!address,
    refetchInterval: 30_000,
  });

  return { address, connect, disconnect, balances, signAndSendPreparedTransaction };
}
```

Nótese: el frontend no construye la transacción desde la intención del usuario. Si el usuario aprieta "Confirm" en una propuesta, el frontend POSTea `function_approve`; el backend responde una unsigned transaction; el frontend la firma/envía con Phantom injected y puede reportar `tx_signature` al backend mediante `function_result`.

### 3.4 Variable de entorno

```bash
# .env.local
# No exponer RPC/provider keys en el frontend. RPC, Helius, Birdeye, Jupiter y risk providers viven en backend/back/services.
```

---

## 4. Layout y estrategia responsive

### 4.1 Breakpoint principal

`md` (768px) en Tailwind separa los dos modos. Por debajo: shell mobile. Por encima: shell desktop.

### 4.2 Shell desktop (≥ 768px)

Grid de 3 columnas que reproduce el mockup:

```
┌─────────────────────────────────────────────────────────────┐
│  TopBar: balance | Chat / Assets / Explore / History | 🔔   │
├──────────────┬──────────────────────────┬───────────────────┤
│              │                          │                   │
│  Sidebar     │   Chat / Active view     │   Right panel     │
│  - Account   │   - Messages             │   - Total balance │
│  - History   │   - Active proposal      │   - Allocation    │
│  - Quick     │   - Input                │   - Connection    │
│              │                          │                   │
└──────────────┴──────────────────────────┴───────────────────┘
```

Anchos sugeridos: `260px / 1fr / 320px`. La columna central crece.

### 4.3 Shell mobile (< 768px)

Stack vertical, chat-first, navegación con bottom nav o tabs:

```
┌──────────────────────┐
│ Balance card         │  ← Total + asset chips inline
├──────────────────────┤
│                      │
│  Chat area           │  ← Toma el resto del viewport
│  (messages)          │
│                      │
├──────────────────────┤
│ Active proposal card │  ← Aparece cuando hay propuesta
├──────────────────────┤
│ Alert banner         │  ← Si hay (gas, risk)
├──────────────────────┤
│ Input                │  ← Sticky bottom
└──────────────────────┘
```

**Sidebar y panel derecho del desktop** quedan accesibles en mobile vía:
- Sidebar → drawer lateral (Sheet de shadcn)
- Panel derecho → tab "Assets" en bottom nav

### 4.4 Tabs del header (desktop)

`Chat | Assets | Explore | History` — para hackathon:
- **Chat**: la vista principal del mockup. Funcional.
- **Assets**: lista detallada de tokens (visible, funcional básico).
- **Explore**: discovery de tokens vía backend/agent (provider interno, si existe). Stub para fase 2.
- **History**: lista de transacciones vía `/api/wallet/transactions`. Funcional.

---

## 5. Inventario de componentes (mapeado al mockup)

### Layout
- `AppShell` — decide entre Desktop/Mobile según breakpoint
- `TopBar` — desktop: balance + tabs + bell. Mobile: solo balance + bell
- `BottomNav` — solo mobile, tabs Chat/Assets/Explore/History

### Wallet & Assets
- `BalanceCard` — total balance + +X% (24h) badge
- `AssetChip` — píldora con icono + ticker + amount (mobile)
- `AssetList` — versión expandida (desktop right panel + tab Assets)
- `AssetAllocationDonut` — recharts PieChart con leyenda

### Sidebar (desktop)
- `AccountCard` — avatar + "Verified Account" + dirección truncada + Premium badge
- `ChatHistoryList` — items: "Swap SOL for USDC", "Send SOL to Alice"
- `QuickActionsList` — History / Security / Connections / Support

### Chat
- `ChatContainer` — scroll behavior + message list + input
- `MessageList` — virtualizar si > 50 mensajes
- `UserMessage` — burbuja azul, avatar a la derecha
- `AgentMessage` — burbuja gris, icono robot a la izquierda
- `ChatInput` — textarea autoresize + send button + plus button
- `SwapProposalCard` — Pay / Receive / Network Fee / Provider / Cancel + Confirm
  - Variantes: pending, executing, confirmed, failed
- `SendProposalCard` — Recipient / Amount / Memo / Cancel + Confirm
- `GasCongestionAlert` — banner amarillo con icono warning
- `RiskAlert` — banner rojo (token sospechoso, etc.)

### Status
- `ConnectionStatus` — dot verde + "Mainnet Connected" + latency
- `NotificationBell` — con dot rojo si hay nuevas

### Diálogos / Sheets
- `SettingsSheet` — auto-confirm threshold, export key, disconnect
- `MobileSidebarSheet` — el sidebar como drawer

---

## 6. Estado (state management)

### 6.1 Qué vive en Zustand (cliente, persistente parcial)

```typescript
interface ChatStore {
  messages: Message[];
  pendingProposal: PendingProposal | null;   // máximo UNA por sesión
  status: 'idle' | 'thinking' | 'awaiting_approval' | 'executing';

  // Helpers derivados
  isInputBlocked(): boolean;                 // true si status !== 'idle' || pendingProposal != null

  addMessage(msg: Message): void;
  setPendingProposal(p: PendingProposal | null): void;
  setStatus(s: ChatStore['status']): void;
  clearChat(): void;
}

interface PendingProposal {
  function: { name: string; params: object };
  display: { summary: string; fee_usd?: number; provider?: string };
  risk: RiskInfo;
  receivedAt: Date;
}

interface SettingsStore {
  autoConfirmThresholdUsd: number;  // Default $20
  riskWarningsEnabled: boolean;
}
```

**Máquina de estados de la sesión:**

```
idle ─(usuario manda mensaje)─→ thinking
thinking ─(agent responde con text)─→ idle
thinking ─(agent responde con text+execute, auto)─→ idle
thinking ─(agent responde con function_call)─→ awaiting_approval [INPUT BLOQUEADO]
awaiting_approval ─(usuario aprieta Confirm)─→ executing [INPUT BLOQUEADO]
awaiting_approval ─(usuario aprieta Cancel)─→ idle
executing ─(agent responde con text+execute)─→ idle
```

`SettingsStore` se persiste en `localStorage`. `ChatStore` puede persistir el último N mensajes para que sobreviva refresh, **pero NO el `pendingProposal`** — si el usuario refresca, la propuesta se cancela implícitamente.

### 6.2 Qué vive en React Query (server state, todo viene del backend)

- `/api/wallet/balances` — balances + total + 24h change
- `/api/wallet/allocation` — distribución para el donut
- `/api/wallet/transactions` — historial de tx (tab History)
- `/api/chat` — chat, approve, reject (event-driven, no polling)
- `/api/network/status` — connection + latency
- `/api/prices` — precios USD para display

> El front NO consume directamente endpoints de Jupiter, Helius, Birdeye o risk-score. Eso vive todo dentro del agent y de los servicios en `back/services/*`. El front solo conoce los endpoints `/api/wallet/*`, `/api/agent/*`, `/api/network/*` y `/api/prices`.

### 6.3 Qué vive en Phantom injected

- `isConnected`, `address`, `connect`, `disconnect`.
- `signAndSendPreparedTransaction(unsigned_tx_base64)` para transacciones preparadas por backend.
- No duplicar en Zustand. Acceder vía el wrapper `useWallet` sobre `window.phantom.solana`.

---

## 7. Protocolo de comunicación con el agent (function-calling)

El agent y el frontend hablan vía un protocolo de **function-calling**: el agent propone funciones a ejecutar, el frontend muestra la propuesta al usuario y devuelve la aprobación o el rechazo. Para transacciones de usuario, el backend prepara una unsigned transaction y el frontend firma/envía con Phantom injected.

### 7.1 Mensajes del agent → frontend

> **Modelo de sesión:** dentro de una misma sesión de chat solo puede haber **una ejecución pendiente a la vez**. Por eso no hace falta `call_id` para distinguir propuestas — siempre nos referimos a "la propuesta actualmente activa". Mientras hay una propuesta pendiente, el `ChatInput` queda **deshabilitado** hasta que el usuario apruebe o rechace.

```typescript
type RiskInfo = {
  score: number;                          // 0-100
  level: 'low' | 'medium' | 'critical';   // leve / medio / crítico
  reasons?: string[];                     // ej ["High slippage", "Low liquidity"]
};

type AgentMessage =
  // Texto del agent. Si ejecutó algo, viene con `execute`.
  | {
      type: 'text';
      content: string;
      execute?: {
        status: 'success' | 'failed';
        tx_hash?: string;
        error?: string;
      };
      timestamp: Date;
    }

  // Pide ejecución de una función — requiere confirmación del usuario.
  // Bloquea el ChatInput hasta que se reciba function_approve o function_reject.
  // El `risk` SIEMPRE viene en este tipo de mensaje (es el único que lo lleva).
  | {
      type: 'function_call';
      function: {
        name: 'swap' | 'transfer' | 'stake';
        params: SwapParams | TransferParams | StakeParams;
      };
      display: {
        summary: string;                  // ej "Swap 0.5 SOL → ~118 USDC"
        fee_usd?: number;
        provider?: string;
        slippage_bps?: number;
      };
      risk: RiskInfo;
      timestamp: Date;
    }

  // Alerta standalone (no asociada a una ejecución, ej "high network congestion")
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: Date;
    };
```

**Cómo lee el front el campo `execute`:**

| Situación | Cómo lo detecta el front |
|---|---|
| Mensaje de texto sin ejecución | `execute === undefined` |
| Auto-ejecución | `execute` presente |
| Post-aprobación | `execute` presente Y había una propuesta pendiente en sesión (la última `function_call` sin resolver) |

**Cómo lee el front el campo `risk`:**

| `risk.level` | UI |
|---|---|
| `low` | Sin alerta visible (o badge discreto verde "Low risk") |
| `medium` | Banner amarillo `AlertBanner severity="warning"` con `risk.reasons` listados |
| `critical` | Banner rojo `AlertBanner severity="danger"` + el botón Confirm cambia a estilo "destructivo" |

### 7.2 Mensajes del frontend → agent

```typescript
type FrontMessage =
  // Texto del usuario en el chat (solo si no hay propuesta pendiente).
  // `user_threshold_usd` puede venir de Settings si el backend no lo persiste por sesión.
  | { type: 'user_message'; content: string; user_threshold_usd?: number }

  // Usuario aprueba la propuesta activa (la única posible en la sesión)
  | { type: 'function_approve' }

  // Usuario rechaza la propuesta activa
  | { type: 'function_reject' };
```

> Como solo hay una propuesta pendiente por sesión, no hace falta IDs ni echo de la función. El backend sabe cuál es la propuesta activa por el estado de sesión.

### 7.3 Shapes de params por función

```typescript
type SwapParams = {
  amount_in: number;
  token_in: string;          // mint address o ticker
  token_out: string;
  slippage_bps?: number;
};

type TransferParams = {
  amount: number;
  token: string;             // 'SOL' o mint address
  recipient: string;         // dirección Solana base58
  memo?: string;
};

type StakeParams = {
  amount: number;
  validator: string;
};
```

> **Nota:** las direcciones son base58 de Solana, no `0x...` (eso es Ethereum).

### 7.4 Cómo lo renderiza el front

`MessageList` hace switch sobre `type`:

| `type` + condición | Componente |
|---|---|
| `text` (user) | `UserMessage` (burbuja azul) |
| `text` agent, sin `execute` | `AgentMessage` (burbuja gris) |
| `text` agent, con `execute` y SIN propuesta activa en sesión | `TxResultMessage` inline (auto-ejecución) |
| `text` agent, con `execute` y CON propuesta activa en sesión | actualiza el `SwapProposalCard` activo a `confirmed`/`failed` y libera el chat |
| `function_call` | `ProposalCard` (despacha por `function.name`) + bloquea el `ChatInput` + renderiza alerta de `risk` si `level !== 'low'` |
| `alert` | `AlertBanner` (color por severity) |

---

## 8. Flujo de swap end-to-end

> El frontend es un **chat client con frontera de firma Phantom**. No calcula riesgo, no consulta providers externos y no construye txs desde intención de usuario. Sí firma/envía con Phantom las unsigned transactions preparadas por el backend.
>
> **Sesión:** una sola propuesta pendiente por sesión. Mientras hay una propuesta activa, el `ChatInput` queda bloqueado.

### Caso A: operación chica (auto-ejecuta)

1. **Usuario tipea**: "swap 0.1 SOL a USDC"
2. **Front** agrega `{ type: 'user_message' }` al store, status → `thinking`, POSTea a `/api/chat`
3. **Agent** decide que está bajo threshold → ejecuta directo
4. **Agent → Front** devuelve un `text` con `execute`:
   ```json
   [
     {
       "type": "text",
       "content": "Swapped 0.1 SOL for 23.5 USDC",
       "execute": { "status": "success", "tx_hash": "5xY..." }
     }
   ]
   ```
5. **Front**: como NO hay propuesta activa en sesión, lo renderiza como `TxResultMessage` inline. Status → `idle`. Refetch de balances.

### Caso B: operación grande (requiere aprobación)

1. **Usuario tipea**: "swap 5 SOL a USDC"
2. **Front** POSTea a `/api/chat`, status → `thinking`
3. **Agent** decide que está sobre threshold → manda `function_call` con `risk`
4. **Agent → Front**:
   ```json
   [
     {
       "type": "function_call",
       "function": {
         "name": "swap",
         "params": { "amount_in": 5, "token_in": "SOL", "token_out": "USDC" }
       },
       "display": { "summary": "Swap 5 SOL → ~1,180 USDC", "fee_usd": 2.10, "provider": "Jupiter" },
       "risk": {
         "score": 65,
         "level": "medium",
         "reasons": ["High network congestion", "Slippage above 0.5%"]
       }
     }
   ]
   ```
5. **Front**:
   - Setea `pendingProposal` en el store, status → `awaiting_approval`.
   - Renderiza el `SwapProposalCard`.
   - Como `risk.level === 'medium'`, renderiza el `AlertBanner` warning con los `reasons` listados.
   - **Bloquea el `ChatInput`** (placeholder cambia a "Confirm or cancel the proposal first").
6. **Usuario aprieta Confirm** → Front POSTea:
   ```json
   { "type": "function_approve" }
   ```
   Status → `executing`. Card pasa a `awaiting_execution`. Input sigue bloqueado.
7. **Agent** ejecuta y devuelve:
   ```json
   [
     {
       "type": "text",
       "content": "Done. Swapped 5 SOL for 1,180 USDC.",
       "execute": { "status": "success", "tx_hash": "5xY..." }
     }
   ]
   ```
8. **Front**: como había una propuesta activa, este `text+execute` la cierra → card pasa a `confirmed`, `pendingProposal = null`, status → `idle`, input desbloqueado, refetch de balances.

### Si el usuario rechaza

6'. **Usuario aprieta Cancel** → Front POSTea `{ "type": "function_reject" }`. Setea `pendingProposal = null`, status → `idle`, desbloquea el input. La card queda en estado `cancelled` en el chat history.
7'. **Agent** opcionalmente devuelve un `text` confirmando ("OK, cancelled."). El front lo agrega normal al chat.

### Estados visuales del SwapProposalCard

El estado lo deriva el front del store (no necesita matchear IDs):

| Estado | Cuándo | UI |
|---|---|---|
| `pending` | Llegó `function_call`, no hubo aún approve/reject | Cancel + Confirm activos. Risk banner si `level !== 'low'` |
| `awaiting_execution` | Front mandó `function_approve`, no llegó aún el `text+execute` | Spinner, botones disabled |
| `confirmed` | Llegó `text+execute` con `status: success` (cerrando la propuesta activa) | Checkmark + link a explorer |
| `failed` | Llegó `text+execute` con `status: failed` | Cruz roja + error + botón Retry |
| `cancelled` | Front mandó `function_reject` | Card grayed-out con "Cancelled" |

> **Single endpoint:** todo va por `POST /api/chat` (texto, approve, reject). El agent decide qué hacer según el `type` del payload. Esto simplifica el cliente.

---

## 9. Auto vs Confirm — lógica

### Decisión: el threshold se decide en el **backend**

El frontend no decide si una operación auto-ejecuta o requiere confirmación. Lo infiere exclusivamente por el shape de la respuesta del agent:
- `text` con `execute` ⇒ el backend/agent ya ejecutó o terminó una ejecución aprobada.
- `function_call` ⇒ el backend/agent requiere confirmación manual.

Por qué:
- El cálculo de USD requiere precios actuales (mejor cachear server-side)
- Permite cambiar lógica de policy sin redeploy del frontend
- Single source of truth

### Cómo lo controla el usuario

Settings → "Auto-confirm threshold" slider, default $20.

```typescript
// front envía el valor de settings junto al mensaje, o el backend lo lee de sesión, en /api/chat
{ type: 'user_message', content: 'swap 0.1 SOL to USDC', user_threshold_usd: 20 }
```

---

## 10. Datos en tiempo real

Todo el polling del frontend va contra endpoints del backend. El frontend no habla con el RPC de Solana directamente.

| Dato | Endpoint | Frecuencia |
|---|---|---|
| Balances (SOL + SPL) | `/api/wallet/balances?address=...` | 30s + refetch on `tx_result` |
| Asset prices (USD) | `/api/prices` | 60s |
| Network status / latency | `/api/network/status` | 30s |
| Transaction history | `/api/wallet/transactions` | on-demand (al abrir tab History) |

**No usar websockets para hackathon**. Polling es suficiente y más debuggeable.

El backend es el que habla con el RPC, Helius, Birdeye y Jupiter. El frontend es agnóstico de qué provider hay abajo.

---

## 11. Contratos de API (formal)

Sección de referencia técnica que define todos los shapes de request/response que el frontend consume del backend. Estos tipos son los que viven en `front/src/types/api.ts` y deben validarse en runtime con Zod (ver 11.9).

### 11.1 Tipos compartidos

```typescript
// front/src/types/api.ts

// Toda response de error del backend tiene este shape
type ApiError = {
  error: {
    code: string;                       // ej "invalid_payload", "no_pending_proposal"
    message: string;                    // human-readable
    details?: Record<string, unknown>;
  };
};

// Wrapper para responses que pueden fallar
type ApiResult<T> = T | ApiError;

// Detección: si la response tiene la key `error`, es ApiError
function isApiError<T>(r: ApiResult<T>): r is ApiError {
  return typeof r === 'object' && r !== null && 'error' in r;
}
```

### 11.2 Headers comunes

Todas las requests JSON incluyen:

```
Content-Type: application/json
Authorization: Bearer <session_token>   # cuando auth real esté definida
```

> **Open question (#7):** cómo se obtiene el `session_token`. Para hackathon mínimo viable: el frontend puede mandar el `address` en el body y el backend confiar — inseguro pero suficiente para demo. **Definir antes de Fase 2.**

### 11.3 POST /api/chat — chat principal con el agent

**Único endpoint para todas las interacciones con el agent**: texto del usuario, aprobación de propuesta, rechazo de propuesta. El backend distingue por el `type` del payload.

Request body (es la unión `FrontMessage` de la sección 7.2):

```typescript
type AgentMessageRequest =
  | { type: 'user_message'; content: string; user_threshold_usd?: number }
  | { type: 'function_approve' }
  | { type: 'function_reject' };
```

Response 200:

```typescript
type AgentMessageResponse = {
  messages: AgentMessage[];   // ver sección 7.1 para la unión completa
};
```

Response errors:

| Code HTTP | `error.code` | Cuándo |
|---|---|---|
| 400 | `invalid_payload` | El body no matchea ningún variant de `AgentMessageRequest` |
| 409 | `no_pending_proposal` | Llegó `function_approve` o `function_reject` pero no había propuesta activa en sesión |
| 409 | `proposal_already_pending` | Llegó `user_message` pero ya hay una propuesta esperando approve/reject (el front debería haber bloqueado el input — defensa en profundidad) |
| 500 | `agent_error` | Error interno del agent al procesar el intent |

### 11.4 GET /api/wallet/balances

Query params:

```typescript
type GetBalancesQuery = {
  address: string;            // base58 Solana
};
```

Response 200:

```typescript
type GetBalancesResponse = {
  balances: TokenBalance[];
  total_usd: number;
  change_24h_pct: number;     // signado, ej 2.4 o -1.7
  updated_at: string;         // ISO 8601
};

type TokenBalance = {
  symbol: string;             // 'SOL', 'USDC', etc.
  mint: string;               // mint address (para SOL nativo, usar 'So11...11112')
  amount: string;             // raw amount como string (BigInt-safe)
  decimals: number;
  ui_amount: number;          // amount / 10^decimals, ya parseado para mostrar
  usd_value: number;
  icon_url?: string;
};
```

### 11.5 GET /api/wallet/allocation

Query params: igual que `balances`.

Response 200:

```typescript
type GetAllocationResponse = {
  total_assets: number;       // count de tokens distintos no-cero
  allocation: AllocationItem[];
};

type AllocationItem = {
  symbol: string;
  percentage: number;         // 0-100
  color?: string;             // hex sin #, ej "3B82F6"
};
```

### 11.6 GET /api/wallet/transactions

Query params:

```typescript
type GetTransactionsQuery = {
  address: string;
  limit?: number;             // default 20, max 100
  before?: string;            // cursor para paginación (tx_hash del último item)
};
```

Response 200:

```typescript
type GetTransactionsResponse = {
  transactions: TxHistoryItem[];
  next_cursor?: string;
};

type TxHistoryItem = {
  tx_hash: string;
  type: 'swap' | 'transfer' | 'stake' | 'other';
  status: 'success' | 'failed';
  timestamp: string;          // ISO 8601
  summary: string;            // ej "Swapped 0.5 SOL → 118 USDC"
  amount_usd?: number;
  explorer_url: string;
};
```

### 11.7 GET /api/network/status

Query params: ninguno.

Response 200:

```typescript
type GetNetworkStatusResponse = {
  connected: boolean;
  network: 'mainnet';
  latency_ms: number;
  tps?: number;
};
```

### 11.8 GET /api/prices

Query params:

```typescript
type GetPricesQuery = {
  symbols: string;            // comma-separated, ej "SOL,USDC,JUP"
};
```

Response 200:

```typescript
type GetPricesResponse = {
  prices: Record<string, number>;   // { SOL: 235.42, USDC: 1.0 }
  updated_at: string;               // ISO 8601
};
```

### 11.9 Validación con Zod

Todo response del backend debe parsearse con Zod antes de usarse en el front. Detecta drift entre lo que el backend manda y lo que el front espera.

```typescript
// front/src/lib/api/schemas.ts
import { z } from 'zod';

export const RiskInfoSchema = z.object({
  score: z.number().min(0).max(100),
  level: z.enum(['low', 'medium', 'critical']),
  reasons: z.array(z.string()).optional(),
});

export const ExecuteSchema = z.object({
  status: z.enum(['success', 'failed']),
  tx_hash: z.string().optional(),
  error: z.string().optional(),
});

export const SwapParamsSchema = z.object({
  amount_in: z.number().positive(),
  token_in: z.string(),
  token_out: z.string(),
  slippage_bps: z.number().optional(),
});

export const AgentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    content: z.string(),
    execute: ExecuteSchema.optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('function_call'),
    function: z.object({
      name: z.enum(['swap', 'transfer', 'stake']),
      params: z.union([SwapParamsSchema /*, TransferParamsSchema, StakeParamsSchema*/]),
    }),
    display: z.object({
      summary: z.string(),
      fee_usd: z.number().optional(),
      provider: z.string().optional(),
      slippage_bps: z.number().optional(),
    }),
    risk: RiskInfoSchema,
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('alert'),
    severity: z.enum(['info', 'warning', 'danger']),
    content: z.string(),
    timestamp: z.string(),
  }),
]);

export const AgentMessageResponseSchema = z.object({
  messages: z.array(AgentMessageSchema),
});

// idem para todos los demás endpoints
```

### 11.10 Resumen de endpoints + frecuencia

| Endpoint | Método | Polling sugerido | Cuándo refetch |
|---|---|---|---|
| `/api/chat` | POST | event-driven | n/a |
| `/api/wallet/balances` | GET | 30s | + on `text+execute` event |
| `/api/wallet/allocation` | GET | 60s | + on `text+execute` event |
| `/api/wallet/transactions` | GET | on-demand | al abrir tab History |
| `/api/network/status` | GET | 30s | — |
| `/api/prices` | GET | 60s | — |

---

## 12. Estados de loading / error / empty

Cada componente que consume async data debe definir los 4 estados:

| Componente | Loading | Error | Empty | Data |
|---|---|---|---|---|
| `BalanceCard` | Skeleton bar | "—" + retry | "$0.00" | Total |
| `AssetAllocationDonut` | Skeleton circle | Hidden | "Sin assets" | Donut |
| `ChatContainer` | — | Toast | "Empezá tipeando..." | Messages |
| `SwapProposalCard` | Spinner en quote | Banner rojo | n/a | Card |
| `ChatHistoryList` | Skeleton list | Hidden | "Sin historial" | List |

Componentes shadcn útiles: `Skeleton`, `Alert`, `Toast`.

---

## 13. Settings (qué incluye)

Sheet/dialog accesible desde sidebar Quick Action:

- **Auto-confirm threshold**: slider $0–$500 (default $20)
- **Network**: solo lectura "Mainnet" (no permitir cambio en hackathon)
- **Risk warnings**: toggle on/off
- **Account**:
  - Mostrar dirección Solana completa + copy
  - "Disconnect" — desconecta Phantom y limpia estado local
- **Sobre**: versión, link a docs

---

## 14. Theming y branding

### Colores derivados del mockup

```css
/* tailwind.config / globals.css */
--primary: 219 91% 56%;          /* Azul de las burbujas user + Confirm */
--primary-foreground: 0 0% 100%;
--success: 142 71% 45%;          /* Verde de "+2.4%" + Premium badge */
--warning: 38 92% 50%;           /* Amarillo del alert de gas */
--danger: 0 84% 60%;             /* Reservado para errores */
--muted: 220 14% 96%;            /* Burbujas agent + cards */
--border: 220 13% 91%;
```

shadcn-init con `--primary` azul. Override del default si hace falta.

**Modo dark**: fuera de scope hackathon (mockup solo light). Dejarlo como follow-up.

### Tipografía

- Inter como default (shadcn la usa).
- Numerales tabulares para balances: `font-feature-settings: 'tnum'`.

---

## 15. Plan de fases para el hackathon

### Fase 1 — Layout shell + mock data ⏳ ahora
- Setup Next + Tailwind + shadcn
- `AppShell` responsive (desktop + mobile)
- Componentes vacíos con datos hardcoded del mockup
- **Deliverable**: tu UI se ve idéntica al mockup, sin lógica

### Fase 2 — Phantom injected auth + balances del backend
- `useWallet` con Phantom injected (connect/disconnect/address)
- ConnectButton funcional con Phantom
- `/api/wallet/balances` consumiendo desde el backend
- `BalanceCard` y `AssetChip` con datos reales

### Fase 3 — Chat con backend mockeado
- `ChatContainer` con state Zustand (incluyendo bloqueo del input)
- Renderizado de todos los `AgentMessage['type']`
- `/api/chat` devolviendo respuestas hardcoded validadas con Zod

### Fase 4 — Swap end-to-end (toda la lógica en el agent)
- Agent en `/api/chat` parsea intent real, decide auto vs aprobación
- Caso A: agent ejecuta y devuelve `text+execute`
- Caso B: agent devuelve `function_call`, front bloquea input, usuario aprueba/rechaza, agent ejecuta
- Frontend solo muestra los `text+execute` con link a explorer y dispara refetch de balances

### Fase 5 — Polish
- Alerts (gas congestion, risk)
- Settings sheet con threshold
- Tab Assets + Tab History funcionales
- Empty states / errores

---

## 16. Qué NO hacer (alcance limitado)

- ❌ Modo dark
- ❌ Multichain (solo Solana)
- ❌ Websockets para real-time
- ❌ Push notifications
- ❌ Tab Explore funcional (placeholder)
- ❌ Multi-cuenta (solo la wallet del login actual)
- ❌ i18n (solo inglés según mockup, o solo español, no las dos)
- ❌ Tests (priorizar features para demo)
- ❌ Animaciones complejas (microinteracciones básicas con `transition` de Tailwind alcanzan)
- ❌ Onramp / fiat (NO compras con tarjeta)

---

## 17. Open questions / pendientes a resolver

1. **¿Idioma del producto?** El mockup tiene texto en inglés ("I'd like to swap...", "Confirm Swap"). ¿Mantenemos inglés en la UI o lo pasamos a español?
2. **¿Primera pantalla pre-login?** Cuando `!isConnected`, ¿qué se ve? Una landing simple con CTA "Sign in with Google" o saltamos directo al modal?
3. **¿Avatar del usuario?** El mockup muestra un avatar de una persona — ¿lo dejamos como placeholder genérico o pulleamos foto de Google profile?
4. **Firma de transacciones:** decisión tomada. El backend prepara unsigned transactions y el frontend las firma/envía con Phantom injected. El backend puede recibir `tx_signature` como callback/proof opcional, pero no recibe `signed_tx_base64`.
5. **¿Threshold en USD o en SOL nativo?** En hackathon, USD es más intuitivo pero requiere price oracle. Alternativa: threshold por % del balance total (no requiere precio absoluto).
6. **Deep links / share:** ¿queremos que un swap proposal sea compartible vía URL? (probablemente fuera de scope)
7. **🔐 Auth front ↔ back.** ¿Cómo se obtiene el `session_token` que va en el header `Authorization`? Para demo mínimo: address en el body sin auth real. Define antes de Fase 2. La firma de transacciones con Phantom no debe reutilizarse como autenticación implícita del API.

---

## 18. Estructura final esperada de la app después de Fase 1

```
Repo root
├── app/
│   ├── layout.tsx                     # Wrap providers
│   ├── page.tsx                       # import App from front/src/App
│   └── api/                           # Backend (otro tema)
├── front/src/
│   ├── App.tsx                        # ✓
│   ├── providers/                     # ✓
│   ├── components/                    # ✓ (con datos hardcoded)
│   ├── hooks/                         # placeholders
│   ├── lib/                           # ✓
│   ├── stores/                        # ✓ vacío
│   └── styles/globals.css             # ✓
├── back/                              # No tocar en Fase 1
├── components.json                    # shadcn config
├── tailwind.config.ts                 # con tokens custom
└── tsconfig.json
```
