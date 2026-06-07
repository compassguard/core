# Technical Spec — Migración del frontend actual al SSoT

**Estado:** activo.  
**SSoT:** [`front/docs/frontend-spec.md`](./frontend-spec.md).  
**Objetivo de este documento:** describir, mirando el código actual, qué hay que cambiar y cómo para que `front/src` cumpla el SSoT.

---

## 0. Resumen ejecutivo

El código actual en `front/src` implementa una app tipo “intent wallet” con:

- `@solana/wallet-adapter-*` y `@solana/web3.js` en el cliente.
- `front/src/pages/Index.tsx` como pantalla principal real.
- Parser local de intents (`lib/intentParser.ts`).
- Risk engine en cliente (`lib/riskEngine.ts` + `lib/risk/providers/*`).
- Quote provider demo en cliente (`lib/quoteProvider.ts`).
- Transaction builder y signing flow en cliente (`lib/transactionBuilder.ts`).
- UI de parse/preview/safety/confirmation, no chat-first.
- Historial persistido en `localStorage`.
- Tema oscuro/neón por defecto.

El SSoT nuevo exige otra arquitectura:

- Next.js App Router + `front/src/App.tsx` como entry UI.
- Phantom Browser Extension / injected provider para login/display y firma/envío de unsigned transactions preparadas por backend.
- Frontend chat-first.
- El frontend **no construye ni simula transacciones desde intención de usuario**.
- El backend prepara unsigned transactions; el frontend las firma/envía con Phantom injected.
- El frontend **no llama directo a Solana RPC, Jupiter, Helius, Birdeye ni risk-score providers**.
- Toda ejecución, risk policy, quotes, receipts y providers viven detrás del backend/agent.
- El frontend consume solo endpoints propios:
  - `POST /api/chat`
  - `GET /api/wallet/balances`
  - `GET /api/wallet/allocation`
  - `GET /api/wallet/transactions`
  - `GET /api/network/status`
  - `GET /api/prices`

Esta spec define una migración por reemplazo controlado: conservar solo lo reutilizable de UI primitives/utilidades y reemplazar el flujo wallet-adapter/risk-engine por el flujo chat + agent.

---

## 1. Estado actual del código

### 1.1 Entry points actuales

| Archivo | Estado actual | Problema contra SSoT | Acción |
|---|---|---|---|
| `app/page.tsx` | Importa `front/src/App.tsx`. | Correcto. | Mantener. |
| `app/layout.tsx` | Importa CSS de wallet adapter y `front/src/index.css`; metadata dice PromiseKeeper. | Wallet adapter queda fuera; metadata desactualizada. | Cambiar imports/metadata al nuevo producto. |
| `front/src/App.tsx` | Monta `ConnectionProvider`, `WalletProvider`, `WalletModalProvider`; usa devnet; renderiza `pages/Index`. | Contradice wallet layer y tx policy. | Reescribir como composición de providers Phantom/Query/Theme + `AppShell`. |
| `front/src/pages/Index.tsx` | Pantalla principal con parser/risk/signing. | No es chat-first y firma en cliente. | Dejar de usar. Reemplazar por componentes `layout/chat/wallet/status`. |

### 1.2 Dependencias actuales relevantes

Actualmente existen dependencias que el frontend nuevo no debería usar en cliente:

- `@solana/wallet-adapter-base`
- `@solana/wallet-adapter-react`
- `@solana/wallet-adapter-react-ui`
- `@solana/wallet-adapter-wallets`
- `@solana/web3.js` para lógica cliente de wallet/RPC/signing
- `@solana/spl-token` para construir transfers en cliente

Faltan dependencias requeridas por el SSoT:

- Phantom injected provider (`window.phantom.solana`)
- `zustand`
- `@tanstack/react-query`
- `zod`
- `date-fns`

`recharts`, `lucide-react`, Tailwind y shadcn/ui ya están disponibles.

### 1.3 Código actual a retirar o aislar

| Archivo/carpeta | Motivo | Acción requerida |
|---|---|---|
| `front/src/lib/transactionBuilder.ts` | Construye y confirma transacciones en cliente. | Eliminar del frontend o mover a backend si se reutiliza. No importarlo desde UI. |
| `front/src/lib/riskEngine.ts` | Calcula risk en cliente. | Eliminar del flujo frontend. Risk viene del agent. |
| `front/src/lib/risk/**` | Providers/risk tests en cliente. | Archivar/eliminar de `front/src` o mover a backend si sirve. |
| `front/src/lib/quoteProvider.ts` | Quote mock/Jupiter-like en cliente. | Reemplazar por display data recibida del backend/agent. |
| `front/src/lib/intentParser.ts` | Parser local. | Reemplazar por `POST /api/chat`. El parsing vive en backend/agent. |
| `front/src/pages/Index.tsx` | Flow viejo parse/preview/sign. | No usar como entry. Eventualmente eliminar. |
| `front/src/pages/NotFound.tsx` | Patrón pages legacy. | Usar `app/not-found.tsx` si hace falta. |
| `Header.tsx`, `LandingHero.tsx` | Dependen de `WalletMultiButton`. | Reescribir para Phantom injected o reemplazar por `TopBar`/landing simple. |
| `ConfirmationSection.tsx` | Pide firma wallet y high-risk phrase local. | Reemplazar por proposal cards Confirm/Cancel que postean al agent. |
| `SafetyReviewPanel.tsx` | Renderiza `RiskAssessment` viejo con levels `LOW/MEDIUM/HIGH/BLOCKED`. | Reemplazar por `RiskAlert`/badges basados en `RiskInfo` del agent (`low/medium/critical`). |
| `HistoryPanel.tsx` | Usa localStorage para tx history. | Reemplazar por `/api/wallet/transactions`. Chat history local puede quedar separado. |
| `ParsedIntentPanel.tsx` | UI del parser local. | No forma parte del chat-first target. El agent puede explicar intent en mensajes. |
| `TransactionPreviewPanel.tsx` | Preview generado por cliente. | Reemplazar por `SwapProposalCard`/`SendProposalCard` con display payload del agent. |

---

## 2. Arquitectura objetivo

```txt
app/layout.tsx
  -> imports front/src/styles/globals.css o front/src/index.css ya migrado

app/page.tsx
  -> import App from '@/App'

front/src/App.tsx
  -> QueryProvider
  -> PhantomProvider
  -> ThemeProvider
  -> AppShell
       -> DesktopShell | MobileShell
            -> TopBar / BottomNav
            -> Sidebar
            -> ChatContainer
            -> RightPanel / Assets views
```

Regla central: `front/src` no consume providers externos ni construye transacciones de negocio. Si se necesita información blockchain, se pide a `/api/*`. La única excepción permitida es deserializar una unsigned transaction preparada por backend y enviarla con Phantom injected.

---

## 3. Nueva estructura de carpetas

Crear/ajustar `front/src` hacia esta estructura:

```txt
front/src/
├── App.tsx
├── providers/
│   ├── PhantomProvider.tsx
│   ├── QueryProvider.tsx
│   └── ThemeProvider.tsx
├── components/
│   ├── ui/                         # shadcn existente, mantener
│   ├── layout/
│   │   ├── AppShell.tsx
│   │   ├── DesktopShell.tsx
│   │   ├── MobileShell.tsx
│   │   ├── TopBar.tsx
│   │   ├── BottomNav.tsx
│   │   └── RightPanel.tsx
│   ├── wallet/
│   │   ├── ConnectButton.tsx
│   │   ├── BalanceCard.tsx
│   │   ├── AssetChip.tsx
│   │   ├── AssetList.tsx
│   │   └── AssetAllocationDonut.tsx
│   ├── sidebar/
│   │   ├── AccountCard.tsx
│   │   ├── ChatHistoryList.tsx
│   │   ├── QuickActionsList.tsx
│   │   └── SettingsSheet.tsx
│   ├── chat/
│   │   ├── ChatContainer.tsx
│   │   ├── MessageList.tsx
│   │   ├── UserMessage.tsx
│   │   ├── AgentMessage.tsx
│   │   ├── TxResultMessage.tsx
│   │   ├── ChatInput.tsx
│   │   ├── AlertBanner.tsx
│   │   └── proposals/
│   │       ├── ProposalCard.tsx
│   │       ├── SwapProposalCard.tsx
│   │       ├── SendProposalCard.tsx
│   │       └── StakeProposalCard.tsx
│   └── status/
│       ├── ConnectionStatus.tsx
│       └── NotificationBell.tsx
├── hooks/
│   ├── useWallet.ts
│   ├── useAgentMessage.ts
│   ├── useWalletBalances.ts
│   ├── useWalletAllocation.ts
│   ├── useTransactionHistory.ts
│   ├── useNetworkStatus.ts
│   └── useAutoConfirmThreshold.ts
├── lib/
│   ├── api/
│   │   ├── client.ts
│   │   └── schemas.ts
│   ├── chat/
│   │   └── messageTypes.ts
│   ├── phantom/
│   │   └── config.ts
│   ├── format.ts
│   └── utils.ts
├── stores/
│   ├── chatStore.ts
│   └── settingsStore.ts
├── types/
│   ├── api.ts
│   ├── chat.ts
│   └── wallet.ts
└── styles/
    └── globals.css
```

Notas:

- Se puede mantener `front/src/index.css` temporalmente, pero debe migrarse a `front/src/styles/globals.css` para coincidir con el SSoT.
- `components/ui/*` se conserva.
- Los componentes viejos pueden convivir durante la migración solo si no son importados por `AppShell`.

---

## 4. Providers React

### 4.1 `front/src/App.tsx`

Reescribir completamente. No debe importar wallet adapter ni `@solana/web3.js`.

Target:

```tsx
'use client';

import { AppShell } from './components/layout/AppShell';
import { PhantomProvider } from './providers/PhantomProvider';
import { QueryProvider } from './providers/QueryProvider';
import { ThemeProvider } from './providers/ThemeProvider';
import { Toaster } from '@/components/ui/toaster';

export default function App() {
  return (
    <QueryProvider>
      <PhantomProvider>
        <ThemeProvider>
          <AppShell />
          <Toaster />
        </ThemeProvider>
      </PhantomProvider>
    </QueryProvider>
  );
}
```

### 4.2 `types/phantom.ts` y `hooks/useWallet.ts`

Usar el provider injected de Phantom:

```tsx
'use client';

export function getPhantomProvider() {
  return window.phantom?.solana?.isPhantom ? window.phantom.solana : undefined;
}
```

Exponer solo `signAndSendPreparedTransaction(unsigned_tx_base64)` para transacciones preparadas por backend. No exponer builders ni RPC genérico.

### 4.3 `providers/QueryProvider.tsx`

Crear `QueryClientProvider` de React Query. Defaults sugeridos:

- `staleTime`: 15–30s para wallet/network.
- `retry`: 1–2.
- `refetchOnWindowFocus`: true para balances/network.

### 4.4 `providers/ThemeProvider.tsx`

Para hackathon, light mode por defecto. El SSoT deja dark mode fuera de alcance.

Acción sobre CSS actual:

- Reemplazar paleta oscura/neón de `index.css` por tokens light del SSoT.
- Eliminar overrides específicos de wallet adapter.
- Mantener tokens shadcn y helpers globales.

---

## 5. Wallet layer

### 5.1 `hooks/useWallet.ts`

Wrapper único alrededor de Phantom injected + balances backend.

Debe devolver:

```ts
type UseWalletResult = {
  isConnected: boolean;
  address?: string;
  connect: () => Promise<void> | void;
  disconnect: () => Promise<void> | void;
  exportPrivateKey?: () => Promise<void> | void;
  balances?: GetBalancesResponse;
  isBalancesLoading: boolean;
  balancesError?: Error;
};
```

Implementación conceptual:

- Obtener conexión, address, connect/disconnect y firma/envío desde `window.phantom.solana` mediante el wrapper `useWallet`.
- Derivar `solanaAddress` desde `addresses.find(a => a.type === 'solana')`.
- Llamar `useWalletBalances(solanaAddress)`.

Permitido:

- `signAndSendPreparedTransaction(unsigned_tx_base64)`
- deserializar `VersionedTransaction` desde payload backend
- `signAndSendTransaction` únicamente dentro del helper de Phantom

Prohibido:

- `signTransaction`
- `sendTransaction`
- `Connection`
- `clusterApiUrl`
- `PublicKey`
- cualquier RPC/provider externo o construcción de transacciones desde intención de usuario.

### 5.2 `ConnectButton.tsx`

Reemplaza `WalletMultiButton`.

Estados:

- Disconnected: botón “Sign in with Google”.
- Connecting/loading: disabled + spinner.
- Connected: address truncada + dropdown/sheet con copy, settings, disconnect.

---

## 6. Estado cliente

### 6.1 `stores/chatStore.ts`

Zustand store:

```ts
interface ChatStore {
  messages: ChatMessage[];
  pendingProposal: PendingProposal | null;
  proposalUiState: 'pending' | 'awaiting_execution' | 'confirmed' | 'failed' | 'cancelled' | null;
  status: 'idle' | 'thinking' | 'awaiting_approval' | 'executing';

  isInputBlocked: () => boolean;
  addMessage: (msg: ChatMessage) => void;
  addMessages: (msgs: AgentMessage[]) => void;
  setPendingProposal: (p: PendingProposal | null) => void;
  setProposalUiState: (s: ChatStore['proposalUiState']) => void;
  setStatus: (s: ChatStore['status']) => void;
  clearChat: () => void;
}
```

Persistencia:

- Persistir últimos N mensajes si se quiere.
- No persistir `pendingProposal`.
- Si hay refresh, propuesta activa se cancela implícitamente.

### 6.2 `stores/settingsStore.ts`

```ts
interface SettingsStore {
  autoConfirmThresholdUsd: number; // default 20
  riskWarningsEnabled: boolean;
  setAutoConfirmThresholdUsd: (v: number) => void;
  setRiskWarningsEnabled: (v: boolean) => void;
}
```

Persistir en `localStorage` vía Zustand persist.

---

## 7. Tipos y API contracts

Crear `front/src/types/api.ts` como contrato único frontend/backend.

### 7.1 Errores

```ts
export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiResult<T> = T | ApiError;
```

### 7.2 Agent messages

Usar los shapes del SSoT:

```ts
export type RiskInfo = {
  score: number;
  level: 'low' | 'medium' | 'critical';
  reasons?: string[];
};

export type ExecuteInfo = {
  status: 'success' | 'failed';
  tx_hash?: string;
  error?: string;
};

export type AgentMessage =
  | {
      type: 'text';
      content: string;
      execute?: ExecuteInfo;
      timestamp: string;
    }
  | {
      type: 'function_call';
      function: {
        name: 'swap' | 'transfer' | 'stake';
        params: SwapParams | TransferParams | StakeParams;
      };
      display: {
        summary: string;
        fee_usd?: number;
        provider?: string;
        slippage_bps?: number;
      };
      risk: RiskInfo;
      timestamp: string;
    }
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: string;
    };

export type AgentMessageRequest =
  | { type: 'user_message'; content: string; user_threshold_usd?: number }
  | { type: 'function_approve' }
  | { type: 'function_reject' };

export type AgentMessageResponse = {
  messages: AgentMessage[];
};
```

### 7.3 Wallet endpoints

Implementar tipos del SSoT para:

- `GetBalancesResponse`
- `GetAllocationResponse`
- `GetTransactionsResponse`
- `GetNetworkStatusResponse`
- `GetPricesResponse`

No reutilizar `RiskAssessment`, `ParsedIntent`, `SwapQuote`, `TransactionPreview` del código viejo.

---

## 8. Zod schemas

Crear `front/src/lib/api/schemas.ts`.

Validar runtime responses de todos los endpoints propios.

Reglas:

- `timestamp` llega como string ISO desde backend, no `Date` serializado.
- `amount` raw viene como string para balances.
- `network` solo `mainnet` para frontend hackathon.
- `risk.level` es `low | medium | critical`, no `LOW | MEDIUM | HIGH | BLOCKED`.

Prohibido crear schemas de responses directas de Jupiter/Helius/Birdeye.

---

## 9. API client

Crear `front/src/lib/api/client.ts`.

Funciones obligatorias:

```ts
postAgentMessage(body: AgentMessageRequest): Promise<AgentMessageResponse>
getBalances(address: string): Promise<GetBalancesResponse>
getAllocation(address: string): Promise<GetAllocationResponse>
getTransactions(query: GetTransactionsQuery): Promise<GetTransactionsResponse>
getNetworkStatus(): Promise<GetNetworkStatusResponse>
getPrices(symbols: string[]): Promise<GetPricesResponse>
```

Cada función:

1. Usa `fetch` contra endpoint propio `/api/*`.
2. Incluye `Content-Type: application/json` cuando aplica.
3. Incluye `Authorization` solo cuando se defina auth real.
4. Parse JSON.
5. Si response contiene `error`, lanzar `ApiClientError` o devolver error controlado según convención elegida.
6. Validar con Zod.
7. Retornar tipo seguro.

---

## 10. Hooks de data fetching

### 10.1 `useAgentMessage.ts`

Mutation de React Query o función wrapper. Debe coordinar con `chatStore`:

#### User message flow

1. Si `pendingProposal != null`, no enviar.
2. Agregar mensaje local de usuario.
3. `status = 'thinking'`.
4. POST `/api/chat` con `{ type: 'user_message', content, user_threshold_usd }`.
5. Procesar `AgentMessage[]`:
   - `text`: agregar al chat.
   - `function_call`: set `pendingProposal`, `proposalUiState = 'pending'`, `status = 'awaiting_approval'`.
   - `alert`: agregar al chat/alert list.
   - `text+execute`: si no había propuesta, renderizar como auto-exec result y refetch wallet data.
6. Si no queda propuesta, `status = 'idle'`.

#### Approve flow

1. Requiere `pendingProposal`.
2. `status = 'executing'`, `proposalUiState = 'awaiting_execution'`.
3. POST `{ type: 'function_approve' }`.
4. Esperar `text+execute`.
5. Si success: `proposalUiState = 'confirmed'`, `pendingProposal = null`, `status = 'idle'`, refetch balances/allocation.
6. Si failed: `proposalUiState = 'failed'`, `pendingProposal = null`, `status = 'idle'`.

#### Reject flow

1. POST `{ type: 'function_reject' }`.
2. `proposalUiState = 'cancelled'`.
3. `pendingProposal = null`.
4. `status = 'idle'`.
5. Agregar respuesta textual del agent si viene.

### 10.2 Wallet/network hooks

- `useWalletBalances(address)` → `/api/wallet/balances`, refetch 30s.
- `useWalletAllocation(address)` → `/api/wallet/allocation`, refetch 60s.
- `useTransactionHistory(address)` → `/api/wallet/transactions`, enabled al abrir History.
- `useNetworkStatus()` → `/api/network/status`, refetch 30s.
- `usePrices(symbols)` → `/api/prices`, refetch 60s.

---

## 11. Layout target

### 11.1 `AppShell.tsx`

Responsabilidad:

- Leer estado de wallet.
- Si no conectado: mostrar pre-login/landing simple con `ConnectButton`.
- Si conectado: decidir layout responsive.

Breakpoint:

- `md` Tailwind.
- Puede usarse CSS responsive; no hace falta JS breakpoint salvo para drawers.

### 11.2 Desktop shell

Grid:

```txt
TopBar full width
Sidebar 260px | Main 1fr | RightPanel 320px
```

Componentes:

- `TopBar`: balance + tabs + notification bell.
- `Sidebar`: account card, chat history, quick actions/settings.
- Centro: `ChatContainer`.
- Derecha: `BalanceCard`, `AssetAllocationDonut`, `AssetList`, `ConnectionStatus`.

### 11.3 Mobile shell

Chat-first:

```txt
Balance card
Chat area
Active proposal card
Alert banner
Sticky input
BottomNav
```

- Sidebar desktop pasa a `Sheet`.
- Right panel pasa a tab `Assets`.

---

## 12. Chat UI

### 12.1 `ChatContainer`

Responsabilidades:

- Renderizar `MessageList`.
- Renderizar active proposal si existe.
- Renderizar alerts relevantes.
- Renderizar `ChatInput` sticky/bottom.
- Mantener scroll al último mensaje.

### 12.2 `MessageList`

Switch:

| Mensaje | Componente |
|---|---|
| User local | `UserMessage` |
| Agent `text` sin execute | `AgentMessage` |
| Agent `text` con execute sin propuesta activa | `TxResultMessage` |
| Agent `alert` | `AlertBanner` |
| Agent `function_call` | `ProposalCard` |

Si hay >50 mensajes, evaluar virtualización luego; no bloquear Fase 1–3.

### 12.3 `ChatInput`

- Textarea autoresize.
- Send button.
- Plus button visual, sin funcionalidad compleja en hackathon.
- Disabled si `status !== 'idle' || pendingProposal != null`.
- Placeholder disabled: “Confirm or cancel the proposal first”.

---

## 13. Proposal cards

### 13.1 Modelo UI

Una propuesta activa se deriva del último `function_call` pendiente.

Estados visuales:

- `pending`
- `awaiting_execution`
- `confirmed`
- `failed`
- `cancelled`

No usar `call_id`; el protocolo permite solo una propuesta pendiente.

### 13.2 `SwapProposalCard`

Muestra:

- Summary.
- Pay/Receive desde `function.params` y `display.summary`.
- Network fee si `display.fee_usd`.
- Provider si `display.provider`.
- Slippage si `display.slippage_bps`.
- Risk badge/banner.
- Cancel + Confirm.

Confirm llama `approve`; si backend devuelve `unsigned_tx_base64`, el frontend firma/envía con Phantom injected.

### 13.3 `SendProposalCard`

Muestra:

- Recipient.
- Amount/token.
- Memo si existe.
- Fee si viene.
- Risk.
- Cancel + Confirm.

### 13.4 Risk UI

Mapping desde `RiskInfo`:

| Backend `risk.level` | UI |
|---|---|
| `low` | Badge discreto o sin banner. |
| `medium` | Banner warning amarillo con `risk.reasons`. |
| `critical` | Banner danger rojo y confirm button destructivo. |

No usar `RiskAssessment` viejo ni `LOW/MEDIUM/HIGH/BLOCKED` en UI nueva.

---

## 14. Wallet/assets/status UI

### 14.1 `BalanceCard`

Consume `GetBalancesResponse`:

- `total_usd`
- `change_24h_pct`
- `updated_at`

Estados:

- Loading: skeleton bar.
- Error: “—” + retry.
- Empty: `$0.00`.
- Data: total + 24h badge.

### 14.2 `AssetChip` / `AssetList`

Consume `balances: TokenBalance[]`.

- `amount` raw no se muestra directamente salvo debugging.
- Mostrar `ui_amount`, `symbol`, `usd_value`, `icon_url` si existe.

### 14.3 `AssetAllocationDonut`

Consume `/api/wallet/allocation`.

- Recharts PieChart.
- Empty: “Sin assets”.
- Error: ocultar o compact error.

### 14.4 `ConnectionStatus`

Consume `/api/network/status`.

- Mostrar “Mainnet Connected” si `connected`.
- Mostrar latency.
- Si error: “Network status unavailable”.

---

## 15. Settings

Crear `SettingsSheet` accesible desde sidebar quick actions / account menu.

Incluye:

- Slider auto-confirm threshold `$0–$500`, default `$20`.
- Network read-only: “Mainnet”.
- Toggle risk warnings.
- Dirección completa + copy.
- Disconnect/copy address vía Phantom injected.
- Disconnect: `phantom.disconnect()` + `clearChat()`.
- About/version/docs link.

---

## 16. Backend route boundary desde perspectiva frontend

Aunque esta spec es de frontend, el frontend necesita que existan endpoints agregados propios. El repo actualmente tiene endpoints provider-specific:

- `app/api/jupiter/quote/route.ts`
- `app/api/helius/transactions/route.ts`
- `app/api/birdeye/token-security/route.ts`
- `app/api/risk-score/route.ts`

Estos no deben ser consumidos por `front/src`.

Para cumplir el SSoT se necesitan route handlers propios:

```txt
app/api/chat/route.ts
app/api/wallet/balances/route.ts
app/api/wallet/allocation/route.ts
app/api/wallet/transactions/route.ts
app/api/network/status/route.ts
app/api/prices/route.ts
```

Los endpoints provider-specific pueden quedar como implementación interna/legacy, pero el frontend no debe importarlos ni llamarlos directamente.

---

## 17. CSS/theming

### 17.1 Problemas actuales

`front/src/index.css` actualmente define:

- Tema oscuro por defecto.
- Colores risk legacy.
- Overrides de wallet adapter.
- Texto de producto viejo (“non-custodial”, sign with own wallet) implícito en UI.

### 17.2 Target

- Light mode según mockup.
- Tokens del SSoT:

```css
--primary: 219 91% 56%;
--primary-foreground: 0 0% 100%;
--success: 142 71% 45%;
--warning: 38 92% 50%;
--danger: 0 84% 60%;
--muted: 220 14% 96%;
--border: 220 13% 91%;
```

- Eliminar CSS de `.wallet-adapter-*`.
- Mantener `font-feature-settings: 'tnum'` para balances.
- Dark mode fuera de scope; no invertir esfuerzo en theme toggle.

---

## 18. Package/config changes

### 18.1 Agregar dependencias

```bash
npm install zustand @tanstack/react-query zod date-fns
```

No ejecutar en esta tarea documental; esto es para la fase de implementación.

### 18.2 Retirar o dejar de usar dependencias cliente

Cuando el código deje de importarlas desde `front/src`, evaluar remover:

- `@solana/wallet-adapter-base`
- `@solana/wallet-adapter-react`
- `@solana/wallet-adapter-react-ui`
- `@solana/wallet-adapter-wallets`
- `@solana/spl-token` si solo se usaba para frontend

`@solana/web3.js` puede seguir existiendo si backend lo usa, pero no debe estar en UI client.

### 18.3 `next.config.mjs`

Actualmente transpila wallet adapter packages. Al retirarlos del frontend, remover:

```js
transpilePackages: [
  '@solana/wallet-adapter-base',
  '@solana/wallet-adapter-react',
  '@solana/wallet-adapter-react-ui',
  '@solana/wallet-adapter-wallets',
]
```

No agregar transpile para SDK Phantom salvo que se reintroduzca una dependencia explícita.

### 18.4 `app/layout.tsx`

Cambios:

- Quitar `@solana/wallet-adapter-react-ui/styles.css`.
- Importar `../front/src/styles/globals.css` cuando se migre.
- Metadata:

```ts
export const metadata = {
  title: 'Wallet Copilot',
  description: 'AI wallet copilot for Solana.',
};
```

---

## 19. Migración por fases

### Fase A — Cortar dependencias prohibidas del entry

Objetivo: que `App.tsx` ya no monte wallet adapter ni RPC.

Cambios:

1. Crear `providers/PhantomProvider.tsx`.
2. Crear `providers/QueryProvider.tsx`.
3. Crear `providers/ThemeProvider.tsx` mínimo.
4. Reescribir `App.tsx` para montar providers nuevos.
5. Crear `AppShell` mínimo con mock data.
6. Dejar `pages/Index.tsx` sin uso.

Acceptance:

- `front/src/App.tsx` no importa `@solana/*`.
- La app renderiza shell/landing sin signing.

### Fase B — Layout mock según SSoT

1. Crear `layout/*`.
2. Crear wallet/assets/sidebar/status components con hardcoded data.
3. Migrar CSS a light theme.
4. Reemplazar `Header`/`LandingHero` viejos por `TopBar`/landing simple.

Acceptance:

- Desktop 3 columnas.
- Mobile chat-first.
- No lógica blockchain.

### Fase C — Tipos, schemas y API client

1. Crear `types/api.ts`, `types/chat.ts`, `types/wallet.ts`.
2. Crear `lib/api/schemas.ts`.
3. Crear `lib/api/client.ts`.
4. Crear hooks React Query.

Acceptance:

- Endpoints propios tipeados y validados.
- Ningún schema/provider externo en frontend.

### Fase D — Chat store + protocolo agent mockeado

1. Crear `stores/chatStore.ts`.
2. Crear `stores/settingsStore.ts`.
3. Crear `chat/*` components.
4. Implementar `useAgentMessage` contra mock route o mock fetch.
5. Implementar proposal cards.

Acceptance:

- Una propuesta pendiente máxima.
- Input bloqueado en awaiting approval/executing.
- Confirm/Cancel postean approve/reject.

### Fase E — Backend real + wallet data

1. Conectar `/api/chat` real.
2. Conectar `/api/wallet/*`.
3. Conectar `/api/network/status` y `/api/prices`.
4. Refetch balances/allocation en `text+execute` success.

Acceptance:

- Swap small: `text+execute` auto result.
- Swap large: `function_call` + approve + `text+execute`.
- Frontend firma/envía con Phantom injected solo unsigned transactions preparadas por backend; no llama providers externos directos.

### Fase F — Limpieza final

1. Eliminar o mover fuera de frontend archivos viejos no usados.
2. Remover imports/deps wallet adapter del cliente.
3. Ajustar docs si aparece drift.
4. Verificación estática: buscar imports prohibidos.

---

## 20. Imports prohibidos en `front/src`

Después de la migración, estas búsquedas no deberían devolver usos en UI nueva:

```txt
@solana/wallet-adapter
@solana/web3.js
@solana/spl-token
sendTransaction
signTransaction
ConnectionProvider
WalletProvider
WalletMultiButton
clusterApiUrl
buildTransferTransaction
buildSwapTransaction
assessRisk
JupiterQuoteRiskProvider
BirdeyeTokenSecurityProvider
ExternalRiskScoreProvider
HeliusReceiptProvider
TransactionSimulationProvider
```

Excepción permitida: `signAndSendTransaction` solo dentro del helper de Phantom que recibe `unsigned_tx_base64` desde backend. Excepción temporal adicional: archivos legacy no importados durante migración. En limpieza final también deben salir o moverse.

---

## 21. Qué se puede reutilizar del código actual

| Reutilizable | Cómo |
|---|---|
| `components/ui/*` | Mantener shadcn primitives. |
| `lib/utils.ts` | Mantener `cn()`. |
| Parte visual de cards viejas | Copiar estilos puntuales si ayudan, pero no lógica. |
| `history.ts` | Puede inspirar chat history local, pero tx history real debe venir de `/api/wallet/transactions`. |
| `tokens.ts` | Solo para mock display en Fase 1, no como source of truth de ejecución. |

No reutilizar lógica de parse/risk/signing en el frontend nuevo.

---

## 22. Definition of Done

La migración cumple el SSoT cuando:

- `front/src/App.tsx` monta Phantom/Query/Theme providers y `AppShell`.
- No se usa `front/src/pages/Index.tsx` como entry real.
- No hay wallet adapter en la UI nueva.
- No hay RPC/provider externo ni transaction builder en frontend.
- La firma/envío en frontend se limita a unsigned transactions preparadas por backend.
- El login/display wallet usa Phantom injected.
- El chat usa `POST /api/chat`.
- El frontend soporta `text`, `function_call`, `alert`, `text+execute`.
- Solo hay una propuesta pendiente por sesión.
- Confirm llama approve; si backend devuelve unsigned tx, el frontend firma/envía con Phantom y puede reportar `tx_signature`.
- Balances/allocation/history/network/prices vienen de `/api/*` propios.
- Responses se validan con Zod.
- Tema/layout cumplen el mockup light del SSoT.
- Cualquier doc activo sigue apuntando a `frontend-spec.md` como fuente de verdad.
