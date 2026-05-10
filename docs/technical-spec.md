# Especificación Técnica — Conexión Directa con Phantom Wallet

**Versión:** 1.0  
**Fecha:** 2026-05-09  
**Estado:** Draft para implementación  

---

## 1. Arquitectura Propuesta

### 1.1. Diagrama de flujo de conexión

```
┌─────────────┐
│   Usuario   │
└──────┬──────┘
       │ 1. Clic "Connect Phantom"
       ▼
┌──────────────────────────┐
│  ConnectButton.tsx       │
│  - Llama wallet.connect()│
└──────┬───────────────────┘
       │ 2. Ejecuta connect()
       ▼
┌──────────────────────────┐
│  useWallet.ts            │
│  - Detecta window.phantom│
│  - Llama connect()       │
└──────┬───────────────────┘
       │ 3. Solicita conexión
       ▼
┌──────────────────────────┐
│  window.phantom.solana   │
│  (Provider inyectado)    │
└──────┬───────────────────┘
       │ 4. Popup de aprobación
       ▼
┌──────────────────────────┐
│  Usuario aprueba         │
└──────┬───────────────────┘
       │ 5. Retorna publicKey
       ▼
┌──────────────────────────┐
│  useWallet.ts            │
│  - Guarda address        │
│  - Actualiza estado      │
└──────┬───────────────────┘
       │ 6. Re-renderiza UI
       ▼
┌──────────────────────────┐
│  ConnectButton.tsx       │
│  - Muestra address       │
│  - Estado "conectado"    │
└──────────────────────────┘
```

### 1.2. Componentes afectados

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `FRONT/src/providers/PhantomProvider.tsx` | **Eliminar o reemplazar** | Provider del SDK, ya no necesario |
| `FRONT/src/providers/phantomConfig.ts` | **Eliminar** | Configuración de App ID/redirect, obsoleto |
| `FRONT/src/hooks/useWallet.ts` | **Reescribir** | Implementar lógica de conexión directa |
| `FRONT/src/components/wallet/ConnectButton.tsx` | **Actualizar** | Cambiar texto y lógica de conexión |
| `FRONT/src/components/auth/AuthCallbackPage.tsx` | **Eliminar** | Ya no hay callback OAuth |
| `app/auth/callback/page.tsx` | **Eliminar** | Ya no hay ruta de callback |
| `app/page.tsx` | **Actualizar** | Remover `PhantomProvider` si se elimina |
| `app/layout.tsx` | **Verificar** | Asegurar que no depende de SDK provider |

---

## 2. Implementación Detallada

### 2.1. Nuevo hook `useWallet.ts`

**Responsabilidades:**
- Detectar `window.phantom?.solana`.
- Exponer métodos `connect()` y `disconnect()`.
- Mantener estado de conexión y dirección pública.
- Manejar eventos de cambio de cuenta (`accountChanged`).
- Manejar desconexión (`disconnect` event).

**API propuesta:**

```typescript
interface UseWalletReturn {
  isConnected: boolean;
  isConnecting: boolean;
  address: string | undefined;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  walletError: string | undefined;
  balances?: WalletBalances;
  isBalancesLoading: boolean;
  balancesError: Error | null;
}

export function useWallet(): UseWalletReturn;
```

**Implementación aproximada:**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { useWalletBalances } from './useWalletBalances';

type PhantomProvider = {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  disconnect: () => Promise<void>;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
};

function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  
  const provider = (window as any).phantom?.solana;
  
  if (provider?.isPhantom) {
    return provider;
  }
  
  return null;
}

export function useWallet() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [walletError, setWalletError] = useState<string | undefined>(undefined);
  
  const balancesQuery = useWalletBalances(address);
  
  const connect = useCallback(async () => {
    setIsConnecting(true);
    setWalletError(undefined);
    
    try {
      const provider = getPhantomProvider();
      
      if (!provider) {
        throw new Error('Phantom wallet not detected. Please install it from https://phantom.app/download');
      }
      
      const response = await provider.connect();
      const publicKey = response.publicKey.toString();
      
      setAddress(publicKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to Phantom';
      setWalletError(message);
      console.error('[useWallet] connect error:', error);
    } finally {
      setIsConnecting(false);
    }
  }, []);
  
  const disconnect = useCallback(async () => {
    setWalletError(undefined);
    
    try {
      const provider = getPhantomProvider();
      
      if (provider) {
        await provider.disconnect();
      }
      
      setAddress(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disconnect';
      setWalletError(message);
      console.error('[useWallet] disconnect error:', error);
    }
  }, []);
  
  // Event listeners para cambios de cuenta y desconexión
  useEffect(() => {
    const provider = getPhantomProvider();
    
    if (!provider) return;
    
    const handleAccountChanged = (publicKey: { toString: () => string } | null) => {
      if (publicKey) {
        setAddress(publicKey.toString());
      } else {
        setAddress(undefined);
      }
    };
    
    const handleDisconnect = () => {
      setAddress(undefined);
    };
    
    provider.on('accountChanged', handleAccountChanged);
    provider.on('disconnect', handleDisconnect);
    
    // Auto-connect si ya estaba conectado anteriormente
    if (provider.isConnected) {
      provider.connect({ onlyIfTrusted: true })
        .then((response: any) => {
          setAddress(response.publicKey.toString());
        })
        .catch((error: any) => {
          console.info('[useWallet] auto-connect skipped:', error.message);
        });
    }
    
    return () => {
      provider.off('accountChanged', handleAccountChanged);
      provider.off('disconnect', handleDisconnect);
    };
  }, []);
  
  return {
    isConnected: Boolean(address),
    isConnecting,
    address,
    connect,
    disconnect,
    walletError,
    balances: balancesQuery.data,
    isBalancesLoading: balancesQuery.isLoading,
    balancesError: balancesQuery.error,
  };
}
```

---

### 2.2. Actualización de `ConnectButton.tsx`

**Cambios necesarios:**

1. Cambiar texto de "Sign in with Google" a "Connect Phantom".
2. Mostrar mensaje de error si Phantom no está instalada.
3. Proveer enlace a descarga en caso de error.

**Ejemplo de cambio:**

```typescript
// Antes:
<Button onClick={connect} ...>
  Sign in with Google
</Button>

// Después:
<Button onClick={connect} ...>
  {isBusy || wallet.isConnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
  Connect Phantom
</Button>

{wallet.walletError ? (
  <div className="mt-2 max-w-xs rounded-lg bg-error-surface p-3 text-sm text-error-text">
    <p>{wallet.walletError}</p>
    {wallet.walletError.includes('not detected') && (
      <a
        href="https://phantom.app/download"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-xs underline"
      >
        Download Phantom
      </a>
    )}
  </div>
) : null}
```

---

### 2.3. Eliminación de archivos obsoletos

**Archivos a eliminar:**

```bash
rm FRONT/src/providers/PhantomProvider.tsx
rm FRONT/src/providers/phantomConfig.ts
rm FRONT/src/providers/__tests__/phantom-config-validation.test.ts
rm FRONT/src/components/auth/AuthCallbackPage.tsx
rm app/auth/callback/page.tsx
```

**Nota:** Antes de eliminar, hacer grep para asegurar que ningún otro archivo los importa.

---

### 2.4. Actualización de `app/page.tsx`

**Antes:**

```typescript
import { PhantomProvider } from '@/providers/PhantomProvider';

export default function Page() {
  return (
    <PhantomProvider>
      <App />
    </PhantomProvider>
  );
}
```

**Después:**

```typescript
import { App } from '@/App';

export default function Page() {
  return <App />;
}
```

**Nota:** Si hay otros providers (QueryProvider, ThemeProvider), conservarlos. Solo remover PhantomProvider del SDK.

---

### 2.5. Limpieza de dependencias en `package.json`

**Remover:**

```json
"@phantom/react-sdk": "^2.0.2"
```

**Ejecutar después:**

```bash
npm install
```

---

### 2.6. Limpieza de variables de entorno

**Remover de `.env.example` y cualquier `.env.local`:**

```bash
NEXT_PUBLIC_PHANTOM_APP_ID=
NEXT_PUBLIC_PHANTOM_REDIRECT_URL=
```

**Nota:** Según la regla del Safe Secrets Guardrail, NO leer archivos `.env*` reales. Solo actualizar `.env.example` como documentación.

---

## 3. Plan de Migración

### Fase 1: Preparación (sin romper nada)

1. Crear nuevo hook `useWallet.ts` con implementación de conexión directa.
2. Crear flag de feature toggle (opcional):
   ```typescript
   const USE_DIRECT_PHANTOM = process.env.NEXT_PUBLIC_USE_DIRECT_PHANTOM === 'true';
   ```
3. Hacer que `ConnectButton` use el nuevo hook solo si el flag está activo.

**Criterio de validación:** La app sigue funcionando con el flujo antiguo si el flag está desactivado.

---

### Fase 2: Implementación

1. Activar flag de feature toggle.
2. Actualizar `ConnectButton.tsx` para usar nuevo hook.
3. Verificar que la conexión funciona.
4. Ejecutar tests manuales.

**Criterio de validación:** La app se conecta correctamente a Phantom sin OAuth.

---

### Fase 3: Limpieza

1. Eliminar archivos obsoletos (PhantomProvider, phantomConfig, AuthCallbackPage, etc.).
2. Remover `@phantom/react-sdk` del `package.json`.
3. Remover variables de entorno obsoletas de `.env.example`.
4. Remover flag de feature toggle.
5. Hacer commit limpio.

**Criterio de validación:** No queda código muerto, no quedan imports rotos.

---

## 4. Testing

### 4.1. Tests manuales

| Caso | Pasos | Resultado esperado |
|------|-------|-------------------|
| Conexión exitosa | 1. Tener Phantom instalada<br>2. Clic en "Connect Phantom"<br>3. Aprobar en popup | Dirección visible, estado conectado |
| Sin Phantom | 1. Desinstalar Phantom<br>2. Clic en "Connect Phantom" | Error claro + enlace a descarga |
| Desconexión | 1. Conectado<br>2. Clic en "Disconnect" | Vuelve a estado desconectado |
| Cambio de cuenta | 1. Conectado<br>2. Cambiar cuenta en Phantom | UI se actualiza con nueva dirección |
| Rechazo de conexión | 1. Clic en "Connect Phantom"<br>2. Rechazar en popup | Mensaje de error claro |

### 4.2. Tests automatizados (opcional, recomendado)

```typescript
// FRONT/src/hooks/__tests__/useWallet.test.ts

import { renderHook, act } from '@testing-library/react';
import { useWallet } from '../useWallet';

describe('useWallet', () => {
  it('should detect missing Phantom provider', async () => {
    const { result } = renderHook(() => useWallet());
    
    await act(async () => {
      try {
        await result.current.connect();
      } catch (error) {
        // Expected
      }
    });
    
    expect(result.current.walletError).toContain('not detected');
  });
  
  // Más tests con mock de window.phantom...
});
```

---

## 5. Riesgos Técnicos

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Phantom no inyecta provider inmediatamente al cargar página | Medio | Implementar polling o event listener `window.addEventListener('phantom#initialized')` |
| Versiones antiguas de Phantom con API diferente | Bajo | Documentar versión mínima (23.x+), verificar `isPhantom` flag |
| Usuario cambia de cuenta mientras está en la app | Medio | Implementar listener `accountChanged` y actualizar UI |
| Usuario desconecta desde Phantom (no desde la app) | Medio | Implementar listener `disconnect` y resetear estado |
| Tipos TypeScript de Phantom no disponibles | Bajo | Crear tipos custom o usar `@solana/wallet-adapter-base-ui` types (solo tipos, sin runtime) |

---

## 6. Tipos TypeScript

**Recomendación:** Crear archivo de tipos custom para Phantom provider:

```typescript
// FRONT/src/types/phantom.ts

export interface PhantomProvider {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: { toString: () => string };
  
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString: () => string } }>;
  disconnect(): Promise<void>;
  
  signTransaction(transaction: any): Promise<any>;
  signAllTransactions(transactions: any[]): Promise<any[]>;
  signMessage(message: Uint8Array, encoding?: 'utf8'): Promise<{ signature: Uint8Array }>;
  
  on(event: 'connect', handler: (publicKey: { toString: () => string }) => void): void;
  on(event: 'disconnect', handler: () => void): void;
  on(event: 'accountChanged', handler: (publicKey: { toString: () => string } | null) => void): void;
  
  off(event: string, handler: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    phantom?: {
      solana?: PhantomProvider;
    };
  }
}

export {};
```

---

## 7. Seguridad

### 7.1. Verificación de provider legítimo

**Problema:** Un sitio malicioso podría inyectar un objeto `window.phantom` falso.

**Mitigación:**

```typescript
function getPhantomProvider(): PhantomProvider | null {
  const provider = window.phantom?.solana;
  
  // Verificar flag isPhantom
  if (provider?.isPhantom !== true) {
    console.warn('[useWallet] Provider is not genuine Phantom');
    return null;
  }
  
  return provider;
}
```

### 7.2. Validación de publicKey

**Problema:** El provider podría retornar un publicKey inválido.

**Mitigación:**

```typescript
import { PublicKey } from '@solana/web3.js';

const response = await provider.connect();
const publicKeyString = response.publicKey.toString();

try {
  // Validar que sea una dirección Solana válida
  new PublicKey(publicKeyString);
  setAddress(publicKeyString);
} catch (error) {
  throw new Error('Invalid Solana address received from wallet');
}
```

---

## 8. Dependencias adicionales (si necesarias)

**Opcional (solo si se necesitan tipos o utilidades):**

```bash
npm install @solana/web3.js
```

**Nota:** `@solana/web3.js` probablemente ya está instalado para otras funcionalidades. Verificar en `package.json`.

---

## 9. Checklist de Implementación

### Pre-implementación
- [ ] Leer functional-spec.md y technical-spec.md completos.
- [ ] Verificar que Phantom está instalada en navegador de prueba.
- [ ] Hacer backup de archivos que se van a eliminar (por si acaso).

### Implementación
- [ ] Crear tipos TypeScript en `FRONT/src/types/phantom.ts`.
- [ ] Reescribir `FRONT/src/hooks/useWallet.ts` con lógica de conexión directa.
- [ ] Actualizar `FRONT/src/components/wallet/ConnectButton.tsx`.
- [ ] Actualizar `app/page.tsx` para remover `PhantomProvider` del SDK.
- [ ] Verificar que no hay imports rotos.

### Testing
- [ ] Test manual: conexión exitosa.
- [ ] Test manual: sin Phantom instalada.
- [ ] Test manual: desconexión.
- [ ] Test manual: cambio de cuenta.
- [ ] Test manual: rechazo de conexión.

### Limpieza
- [ ] Eliminar `FRONT/src/providers/PhantomProvider.tsx`.
- [ ] Eliminar `FRONT/src/providers/phantomConfig.ts`.
- [ ] Eliminar `FRONT/src/providers/__tests__/phantom-config-validation.test.ts`.
- [ ] Eliminar `FRONT/src/components/auth/AuthCallbackPage.tsx`.
- [ ] Eliminar `app/auth/callback/page.tsx`.
- [ ] Remover `@phantom/react-sdk` de `package.json`.
- [ ] Ejecutar `npm install` para limpiar `node_modules`.
- [ ] Actualizar `.env.example` (remover vars de Phantom App ID).
- [ ] Hacer grep de "phantom-sdk", "PhantomProvider", "PHANTOM_APP_ID" para verificar que no queda código.

### Post-implementación
- [ ] Commit con mensaje descriptivo.
- [ ] Actualizar FRONT/README.md si es necesario.
- [ ] Marcar tarea como completada.

---

## 10. Referencias Técnicas

- [Phantom Provider API](https://docs.phantom.app/solana/provider-api)
- [Connecting to Phantom (Direct)](https://docs.phantom.app/solana/connecting-to-phantom)
- [Handling Events](https://docs.phantom.app/solana/handling-events)
- [@solana/web3.js Documentation](https://solana-labs.github.io/solana-web3.js/)
- [Wallet Standard (future)](https://github.com/wallet-standard/wallet-standard)

---

**Fin de Especificación Técnica**
