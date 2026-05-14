# Technical Spec: Dynamic Wallet Auth

## Estado

- **Versión:** 1.0
- **Fecha:** 2026-05-12
- **Estado:** Draft para implementación
- **Feature:** `dynamic-wallet-auth`

## Resumen técnico

La integración introduce Dynamic como provider de wallets/autenticación en el frontend, pero mantiene una capa propia de sesión y ownership en backend. El frontend deja de depender de Phantom directo como única fuente de wallet y pasa a consumir un adapter interno compatible con wallets Dynamic externas y embedded.

## Arquitectura objetivo

```txt
Usuario
  │
  │ connect / login / create embedded
  ▼
Dynamic SDK
  │
  │ wallet account verificada + dynamic user
  ▼
front/src/hooks/useWallet.ts  ← adapter interno
  │
  │ activeWalletAddress + walletType + signer
  ▼
front/src/hooks/useAgentMessage.ts
  │
  │ Authorization/session + wallet context
  ▼
app/api/* route handlers
  │
  ▼
back/services/*
  │
  ├─ valida sesión app-side + wallet ownership
  ├─ ejecuta guardrails
  └─ prepara unsigned transactions
        │
        ▼
Frontend firma/envía con Dynamic wallet activa
```

## Decisiones técnicas

| Área           | Decisión                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| SDK            | Usar Dynamic React SDK v4 con `@dynamic-labs/sdk-react-core` y `@dynamic-labs/solana`.                            |
| Provider       | Crear `front/src/providers/DynamicWalletProvider.tsx` o integrar `DynamicContextProvider` en `front/src/App.tsx`. |
| Adapter        | Mantener `useWallet()` como API interna para minimizar cambios en componentes existentes.                         |
| Auth backend   | Agregar endpoints propios para crear/verificar sesión app-side basada en Dynamic/wallet activa.                   |
| Historial      | Filtrar conversaciones por wallet activa; guardar `dynamicUserId` como metadato.                                  |
| Signing        | Usar signer/transaction APIs de Dynamic para Solana; frontend firma solo tx preparadas por backend.               |
| Export         | Usar APIs/flujo Dynamic para reveal/export; no manejar private keys en código propio.                             |
| Compatibilidad | Migrar desde Phantom directo sin borrar guardrails ni contratos `/api/chat`.                                      |

## Dependencias nuevas

Agregar al `package.json` raíz:

```bash
npm install @dynamic-labs/sdk-react-core @dynamic-labs/solana
```

Notas:

- Mantener versiones de paquetes Dynamic alineadas entre sí.
- Si se usa custom RPC para Solana, configurar `SolanaWalletConnectorsWithConfig`.
- No reintroducir `@solana/wallet-adapter-*` salvo que una decisión posterior lo requiera.

## Variables de entorno

### Frontend

```env
NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=...
NEXT_PUBLIC_SOLANA_RPC_URL=...
```

### Backend

Según el esquema final de validación Dynamic:

```env
DYNAMIC_ENVIRONMENT_ID=...
APP_SESSION_SECRET=...
```

`DYNAMIC_API_KEY` y `DYNAMIC_WEBHOOK_SECRET` no son requeridas por la implementación actual: el backend valida el JWT de Dynamic contra el JWKS público del environment y no llama APIs privadas de Dynamic.

Reglas:

- `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` puede ser público.
- `DYNAMIC_ENVIRONMENT_ID` identifica el environment server-side, pero no es un secreto.
- Secrets backend como `APP_SESSION_SECRET` no deben exponerse al cliente.
- La sesión propia debe emitirse como cookie httpOnly o token de corta vida; preferir cookie httpOnly si no complica el despliegue.

## Configuración Dynamic requerida

En Dynamic Dashboard:

- Habilitar Solana/SVM.
- Habilitar external wallets Solana necesarias para demo: Phantom, Solflare si aplica.
- Habilitar Embedded Wallets/WaaS V3 para Solana (`SOL`). Si Dynamic muestra `The following chains are not enabled for embedded wallets: SOL`, el problema está en Dashboard, no en el frontend.
- Para Solana testnet/devnet en Dynamic Dashboard, configurar el RPC custom requerido por la chain, por ejemplo:
  - Testnet: `https://api.testnet.solana.com`
  - Devnet: `https://api.devnet.solana.com`
- Definir si embedded wallets se crean automáticamente o manualmente.
- Revisar Private Key Export Settings:
  - Para este producto, recomendado: export habilitado como escape hatch.
  - Si se deshabilita, documentar UX y ocultar botón export.
- Configurar dominios/callbacks permitidos para dev y deploy.
- Configurar MFA/step-up si se decide exigirlo para export o montos altos.

## Componentes afectados

| Archivo                                            | Acción             | Detalle                                                                    |
| -------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `package.json`                                     | modificar          | Agregar paquetes Dynamic.                                                  |
| `front/src/App.tsx`                                | modificar          | Envolver app con `DynamicContextProvider`.                                 |
| `front/src/providers/DynamicWalletProvider.tsx`    | crear              | Encapsular settings Dynamic si se prefiere provider propio.                |
| `front/src/hooks/useWallet.ts`                     | reescribir         | Adapter Dynamic-aware conservando API actual donde sea posible.            |
| `front/src/types/wallet.ts`                        | modificar          | Agregar wallet type, auth status y metadata Dynamic.                       |
| `front/src/types/phantom.ts`                       | deprecar/eliminar  | Reemplazar tipos Phantom-only por tipos wallet genéricos si ya no se usan. |
| `front/src/hooks/useAgentMessage.ts`               | modificar          | Usar auth/session app-side y active wallet Dynamic.                        |
| `front/src/stores/chatStore.ts`                    | modificar          | Filtrar/listar conversaciones por wallet activa.                           |
| `front/src/components/sidebar/ChatHistoryList.tsx` | modificar          | Mostrar solo conversaciones de wallet activa o separar explícitamente.     |
| `front/src/components/wallet/*`                    | modificar          | UI Dynamic connect/disconnect/export/status.                               |
| `front/src/lib/api/client.ts`                      | modificar          | Agregar auth session a requests y endpoints nuevos.                        |
| `app/api/auth/*`                                   | crear              | Endpoints de sesión propia.                                                |
| `app/api/chat/route.ts`                            | verificar          | Preservar auth/session en request.                                         |
| `back/services/auth/*`                             | crear              | Servicio de validación Dynamic/session app-side.                           |
| `back/services/chat.ts`                            | modificar          | Reemplazar confianza en body `user_address` por identidad autenticada.     |
| `back/services/chatSessionStore.ts`                | modificar opcional | Agregar metadata `dynamicUserId`, `walletType`, `verifiedAt`.              |

## Modelo de tipos propuesto

### Wallet adapter frontend

```ts
export type AppWalletType = "external" | "embedded";
export type AppWalletAuthStatus =
  | "unknown"
  | "connected"
  | "verified"
  | "unauthenticated";

export type AppWalletState = {
  isResolved: boolean;
  isAuthenticated: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  address: string | undefined;
  walletType: AppWalletType | undefined;
  walletProvider: string | undefined; // phantom, solflare, dynamic, etc.
  dynamicUserId: string | undefined;
  authStatus: AppWalletAuthStatus;
  walletError: string | undefined;
};

export type AppWalletActions = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signAndSendPreparedTransaction: (
    unsignedTxBase64: string,
    expectedUserAddress?: string,
  ) => Promise<{ tx_signature: string }>;
  exportWallet?: () => Promise<void>;
};
```

### Backend identity

```ts
export type AuthenticatedWalletIdentity = {
  dynamicUserId?: string;
  walletAddress: string;
  walletType: "external" | "embedded";
  walletProvider?: string;
  verifiedAt: string;
};

export type AppSessionClaims = {
  sessionId: string;
  dynamicUserId?: string;
  walletAddress: string;
  walletType: "external" | "embedded";
  issuedAt: number;
  expiresAt: number;
};
```

### Chat session metadata

```ts
export type SessionState = {
  sessionId: string;
  threadId: string;
  userAddress: string | null;
  dynamicUserId?: string;
  walletType?: "external" | "embedded";
  walletProvider?: string;
  messages: SessionHistoryMessage[];
  pendingProposal: PendingProposal | null;
  createdAt: number;
  updatedAt: number;
};
```

## Auth/session backend

### Opción recomendada

Usar Dynamic como verificador primario de login/wallet y emitir una sesión propia.

Endpoints:

```txt
POST /api/auth/dynamic/session
GET  /api/auth/session
POST /api/auth/logout
```

### `POST /api/auth/dynamic/session`

Request:

```ts
type CreateDynamicSessionRequest = {
  dynamicUserId: string;
  walletAddress: string;
  walletType: "external" | "embedded";
  walletProvider?: string;
  dynamicAuthToken?: string;
};
```

Validaciones:

- Verificar token/estado Dynamic server-side.
- Verificar que `walletAddress` pertenece al usuario Dynamic o wallet account verificada.
- Rechazar wallet conectada pero no verificada.
- Emitir sesión app-side.

Response:

```ts
type CreateDynamicSessionResponse = {
  session_id: string;
  wallet_address: string;
  dynamic_user_id?: string;
  expires_at: string;
};
```

### `GET /api/auth/session`

Devuelve identidad autenticada actual si la cookie/token es válida.

### `POST /api/auth/logout`

Revoca o limpia sesión app-side y deja al frontend limpiar runtime.

## Cambios en `/api/chat`

Estado actual: muchas requests envían `user_address` en body.

Estado objetivo:

- `user_address` puede seguir viajando como compatibilidad/diagnóstico.
- Backend debe resolver la identidad real desde sesión app-side.
- Si `body.user_address` existe y no coincide con sesión, responder `wallet_mismatch` o `session_not_found` según contexto.
- Para `get_history`, `function_approve`, `function_reject`, `function_result`, la wallet autorizada viene de sesión.

Regla:

```txt
identity.walletAddress === session.userAddress === pendingProposal.expectedUserAddress
```

cuando aplique.

## Dynamic wallet adapter frontend

### Provider

Ejemplo conceptual:

```tsx
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { SolanaWalletConnectors } from "@dynamic-labs/solana";

export function DynamicWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DynamicContextProvider
      settings={{
        environmentId: process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID!,
        walletConnectors: [SolanaWalletConnectors],
      }}
    >
      {children}
    </DynamicContextProvider>
  );
}
```

Si se necesita custom RPC:

```tsx
import { SolanaWalletConnectorsWithConfig } from "@dynamic-labs/solana";

SolanaWalletConnectorsWithConfig({
  commitment: "confirmed",
  customRpcUrls: {
    solana: [process.env.NEXT_PUBLIC_SOLANA_RPC_URL!],
  },
});
```

### Hook `useWallet`

Responsabilidades:

- Leer usuario y wallets desde Dynamic hooks.
- Resolver la wallet Solana activa.
- Exponer la misma API interna que consume la app hoy.
- Derivar `walletType`:
  - `embedded` para wallet Dynamic/WaaS/MPC.
  - `external` para Phantom/Solflare/etc.
- Implementar `signAndSendPreparedTransaction`.
- Implementar `exportWallet` solo si embedded/export disponible.
- Sincronizar app session al autenticarse/verificarse.

Pseudoflujo:

```ts
const connect = async () => {
  openDynamicAuthFlow();
};

const activeSolanaWallet = findVerifiedSolanaWallet(dynamicWallets);

useEffect(() => {
  if (!dynamicReady) return;
  if (!activeSolanaWallet) {
    clearAppSession();
    return;
  }
  createAppSessionFromDynamicWallet(activeSolanaWallet);
}, [dynamicReady, activeSolanaWallet?.address]);
```

## Signing/send implementation

### Input actual

El backend ya devuelve `unsigned_tx_base64` para firmar/enviar.

### Objetivo

El adapter debe:

1. Decodificar base64 a transaction.
2. Validar `activeWalletAddress` contra `expectedUserAddress`.
3. Usar API Solana de Dynamic para `signAndSendTransaction`.
4. Retornar signature/hash normalizada como `tx_signature`.
5. Verificar que no cambió la wallet activa durante el flujo.

Pseudocódigo conceptual:

```ts
async function signAndSendPreparedTransaction(
  unsignedTxBase64: string,
  expected?: string,
) {
  const wallet = getActiveDynamicSolanaWallet();
  if (!wallet) throw walletError("wallet_not_connected");
  if (expected && wallet.address !== expected)
    throw walletError("wallet_mismatch");

  const tx = decodeTransaction(unsignedTxBase64);
  const signature = await dynamicSignAndSend({ wallet, transaction: tx });

  const current = getActiveDynamicSolanaWallet();
  if (expected && current?.address !== expected)
    throw walletError("account_changed");

  return { tx_signature: signature };
}
```

## Export wallet implementation

### UI

Agregar en settings/wallet panel:

- Mostrar “Export embedded wallet” solo si:
  - wallet activa es embedded
  - Dynamic export está disponible/habilitado
- Mostrar warning:
  - “Nunca compartas tu private key.”
  - “Quien tenga esta clave controla tus fondos.”
  - “Exportar permite importar esta misma wallet en Phantom u otro cliente.”

### Técnica

- Usar flujo Dynamic de reveal/export.
- No guardar la private key en Zustand/localStorage/logs.
- No enviar private key al backend.
- Si Dynamic reporta export disabled, mostrar estado no disponible.

## Historial y wallet switching

Cambios requeridos sobre `wallet-linked-chat-history`:

- `ChatHistoryList` debe filtrar:

```ts
conversation.lastWalletAddress === activeWalletAddress;
```

- `getConversationList()` puede aceptar filtro opcional o exponer `getConversationListForWallet(walletAddress)`.
- Al cambiar wallet:
  - limpiar runtime visible inmediatamente.
  - hidratar solo la wallet nueva.
- Al desconectar Dynamic:
  - limpiar app session.
  - limpiar runtime chat.
  - no borrar bootstraps por wallet salvo logout explícito total.

## Migración desde Phantom directo

### Fase 0: Preparación

- Crear specs y revisar con el equipo.
- Crear app/env en Dynamic Dashboard.
- Confirmar export setting y embedded wallet creation mode.

### Fase 1: Provider Dynamic + adapter

- Instalar paquetes.
- Agregar `DynamicContextProvider`.
- Reescribir `useWallet` detrás de la misma API pública.
- Mantener componentes consumidores lo más intactos posible.

### Fase 2: App session backend

- Agregar endpoints `/api/auth/*`.
- Validar Dynamic/wallet server-side.
- Emitir sesión app-side.
- Propagar sesión a `/api/chat`.

### Fase 3: Chat ownership hardening

- Reemplazar `user_address` como prueba por identidad de sesión.
- Mantener mismatch checks contra `user_address` si se manda.
- Ajustar tests backend.

### Fase 4: History UI

- Filtrar historial por wallet activa.
- Mostrar estado wallet mismatch solo para casos legacy/no filtrados.
- QA con wallet switch real.

### Fase 5: Embedded wallet export

- Agregar settings UI.
- Integrar reveal/export Dynamic.
- QA con export/import en wallet externa si se puede en entorno seguro.

## Testing esperado

### Unit frontend

- `useWallet` expone wallet externa conectada/verificada.
- `useWallet` expone embedded wallet y `walletType=embedded`.
- `signAndSendPreparedTransaction` rechaza wallet mismatch.
- `exportWallet` solo existe para embedded exportable.
- `ChatHistoryList` filtra por wallet activa.
- Wallet switch limpia estado visible.

### Unit backend

- Crear sesión app-side con wallet verificada.
- Rechazar sesión con wallet no verificada.
- Rechazar `/api/chat` sensible sin sesión.
- Rechazar mismatch entre sesión y body `user_address`.
- Rechazar approve/result cuando pending proposal espera otra wallet.

### Integración

- External Phantom via Dynamic → chat → propuesta → firma/envío.
- Embedded wallet → chat → propuesta → firma/envío.
- Wallet A → chat → switch Wallet B → no leakage.
- Embedded wallet export unavailable → UI no rompe.
- Logout Dynamic limpia app session y chat runtime.

### Manual QA

- Dynamic Dashboard dev env configurado.
- Conectar Phantom/Solflare.
- Crear embedded wallet.
- Export embedded wallet en entorno dev.
- Importar exported key en wallet externa solo con fondos de test.
- Transferencia devnet a recipient test.

## Observabilidad y logs

No loguear:

- private keys
- signatures completas si no son necesarias
- auth tokens Dynamic
- app session tokens

Sí loguear con cuidado:

- wallet mismatch reason
- wallet type
- session id interno truncado
- action hash/proposal id
- provider errors normalizados

## Riesgos técnicos

| Riesgo                                        | Mitigación                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| API exacta de Dynamic cambia entre versiones  | Encapsular en adapter y pinnear versiones.                               |
| Dynamic wallet conectada pero no verificada   | Gating explícito antes de crear app session.                             |
| Diferencia de firma entre external y embedded | Tests por wallet type y normalización de signature.                      |
| Export no disponible por dashboard            | Feature detection + UI unavailable.                                      |
| Estado duplicado Dynamic/Zustand              | Dynamic es fuente de wallet; Zustand solo guarda chat/session bootstrap. |
| Historial legacy global aparece               | Migración/filtrado por wallet activa.                                    |

## Definition of Done

- Dynamic provider configurado con Solana.
- Wallet externa y embedded funcionan en entorno dev.
- Backend emite sesión propia y `/api/chat` exige identidad autenticada para acciones sensibles.
- Historial visible está scopeado por wallet activa.
- Transferencia usa guardrails backend y wallet activa Dynamic.
- Export embedded wallet está disponible o explícitamente deshabilitado con UX clara.
- Tests focalizados pasan.
- Documentación/env examples actualizados sin secretos.
