# Especificación Funcional — Conexión Directa con Phantom Wallet

**Versión:** 1.0  
**Fecha:** 2026-05-09  
**Estado:** Draft para revisión  

---

## 1. Alcance

### 1.1. Objetivo

Reemplazar el flujo de login actual (Phantom Embedded Wallet + OAuth con Google) por una **conexión directa con la extensión de navegador Phantom** instalada en la máquina del usuario.

### 1.2. Cambio de paradigma

| Aspecto | Estado actual | Estado objetivo |
|---------|---------------|-----------------|
| **SDK** | `@phantom/react-sdk` (Embedded Wallet SDK) | Eliminado |
| **Login** | OAuth con Google | Conexión directa con wallet instalada |
| **App ID** | Requerido (`NEXT_PUBLIC_PHANTOM_APP_ID`) | No requerido |
| **Redirect URL** | Requerido (`/auth/callback`) | No requerido |
| **Embedded wallet** | Sí (`embeddedWalletType: 'user-wallet'`) | No |
| **Provider** | SDK provider | `window.phantom.solana` (inyectado) o Wallet Standard |
| **Botón** | "Sign in with Google" | "Connect Phantom" |
| **Dependencias OAuth** | Google OAuth flow, callback page | Ninguna |

---

## 2. Requisitos Funcionales

### RF-1: Conexión directa con Phantom

**Criterio de aceptación:**
- El usuario hace clic en "Connect Phantom".
- Si Phantom está instalada, se abre el popup de aprobación de la extensión.
- Si Phantom no está instalada, se muestra un mensaje claro con enlace a `https://phantom.app/download`.
- Al aprobar, la app recibe la dirección pública Solana del usuario.
- No hay redirect a otra página, no hay OAuth, no hay Google login.

### RF-2: Detección de wallet instalada

**Criterio de aceptación:**
- La app detecta `window.phantom?.solana` (provider inyectado por Phantom).
- Si no está disponible, se muestra mensaje: "Phantom wallet not detected. Please install it first."
- Se provee enlace directo a descarga: `https://phantom.app/download`.

### RF-3: Desconexión

**Criterio de aceptación:**
- El usuario puede hacer clic en "Disconnect" y la app olvida la conexión.
- Al refrescar la página, la app recuerda la última wallet conectada (usando `autoConnect: true` o almacenamiento local según implementación).

### RF-4: Display de dirección pública

**Criterio de aceptación:**
- Una vez conectado, se muestra la dirección pública Solana truncada (ej: `7Xg2...k3Qa`).
- Se puede copiar la dirección completa al portapapeles.
- Se mantiene indicador visual de conexión (punto verde).

### RF-5: Eliminación de dependencias OAuth

**Criterio de aceptación:**
- Se elimina la página `/auth/callback`.
- Se eliminan las variables `NEXT_PUBLIC_PHANTOM_APP_ID` y `NEXT_PUBLIC_PHANTOM_REDIRECT_URL`.
- Se remueve `@phantom/react-sdk` del `package.json`.
- No queda código relacionado con Google OAuth.

---

## 3. No-Alcance

**Explícitamente fuera del alcance de esta tarea:**

- ❌ Soporte para otras wallets (Solflare, Backpack, etc.) → queda para fase posterior.
- ❌ Wallet Adapter multi-wallet → se usará conexión directa solo con Phantom por ahora.
- ❌ Cambios en lógica de transacciones o firma → solo se cambia el método de conexión.
- ❌ Persistencia de sesión más allá del almacenamiento local del navegador.
- ❌ Exportación de clave privada (feature existente se puede eliminar o posponer según decisión).

---

## 4. Casos de Uso

### CU-1: Usuario con Phantom instalada

**Precondición:** Phantom browser extension instalada.

**Flujo:**
1. Usuario entra a la app.
2. Ve botón "Connect Phantom".
3. Hace clic.
4. Popup de Phantom se abre pidiendo aprobación.
5. Usuario aprueba.
6. App recibe dirección pública y muestra UI conectada.

**Postcondición:** Usuario conectado, dirección visible, puede usar la app.

---

### CU-2: Usuario sin Phantom instalada

**Precondición:** Phantom NO instalada.

**Flujo:**
1. Usuario entra a la app.
2. Ve botón "Connect Phantom".
3. Hace clic.
4. Se muestra mensaje: "Phantom wallet not detected. Please install it from https://phantom.app/download".
5. Usuario hace clic en el enlace, instala Phantom.
6. Refresca la página.
7. Repite CU-1.

**Postcondición:** Usuario instala wallet y luego se conecta.

---

### CU-3: Usuario desconecta

**Precondición:** Usuario conectado.

**Flujo:**
1. Usuario hace clic en botón "Disconnect" o ícono de logout.
2. App limpia estado de conexión.
3. UI vuelve a estado desconectado.
4. Se muestra nuevamente "Connect Phantom".

**Postcondición:** Usuario desconectado, puede reconectarse.

---

## 5. Criterios de Validación

### CV-1: Verificación manual

- [ ] Instalar Phantom en navegador.
- [ ] Entrar a la app.
- [ ] Hacer clic en "Connect Phantom".
- [ ] Aprobar en popup de Phantom.
- [ ] Verificar que se muestra dirección pública.
- [ ] Hacer clic en copiar dirección, verificar que se copia.
- [ ] Hacer clic en "Disconnect".
- [ ] Verificar que vuelve a estado desconectado.

### CV-2: Verificación sin Phantom

- [ ] Desinstalar Phantom.
- [ ] Entrar a la app.
- [ ] Hacer clic en "Connect Phantom".
- [ ] Verificar mensaje de error claro.
- [ ] Verificar enlace a descarga funcional.

### CV-3: Code Review

- [ ] No queda código de `@phantom/react-sdk`.
- [ ] No queda `PhantomProvider` del SDK.
- [ ] No queda `AuthCallbackPage`.
- [ ] No queda `/auth/callback` route.
- [ ] No quedan variables `NEXT_PUBLIC_PHANTOM_APP_ID` ni `NEXT_PUBLIC_PHANTOM_REDIRECT_URL`.
- [ ] No queda lógica de Google OAuth.

---

## 6. Dependencias y Restricciones

### Dependencias técnicas:
- Phantom browser extension >= 23.x (última estable).
- Navegadores soportados: Chrome, Firefox, Brave, Edge (donde Phantom está disponible).

### Restricciones:
- **No hay backend de autenticación**: la conexión es puramente client-side.
- **No hay sesión persistente en servidor**: la conexión se guarda solo en `localStorage` del navegador.
- **No mobile wallets**: este flujo asume extensión de navegador desktop. Mobile requiere deep linking (fuera de alcance).

---

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Usuario no tiene Phantom instalada | Alta | Medio | Mensaje claro + enlace a descarga |
| Phantom no inyecta provider a tiempo | Baja | Medio | Polling o event listener para detectar provider |
| Usuario rechaza conexión en popup | Media | Bajo | Mensaje de error claro, permitir reintentar |
| Incompatibilidad con versiones antiguas de Phantom | Baja | Bajo | Documentar versión mínima requerida |

---

## 8. Definición de Hecho (DoD)

- [ ] Código implementado y funcionando en local.
- [ ] Tests manuales aprobados (CV-1, CV-2).
- [ ] Code review aprobado (CV-3).
- [ ] Documentación técnica actualizada (technical-spec.md).
- [ ] Variables de entorno obsoletas eliminadas.
- [ ] Dependencias obsoletas removidas del package.json.
- [ ] Commit limpio, sin archivos muertos.
- [ ] README actualizado si es necesario.

---

## 9. Referencias

- [Phantom Wallet Documentation](https://docs.phantom.app/)
- [Phantom Provider API](https://docs.phantom.app/solana/provider-api)
- [Wallet Standard (future consideration)](https://github.com/wallet-standard/wallet-standard)

---

**Fin de Especificación Funcional**
