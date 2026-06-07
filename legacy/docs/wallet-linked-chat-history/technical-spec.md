# Technical Spec: Wallet Linked Chat History

## Arquitectura propuesta

La feature mantiene el backend como fuente de verdad del transcript y agrega identidad de wallet como condicion obligatoria de acceso a una sesion. El frontend deja de persistir una referencia global `sessionId` compartida y pasa a persistir un bootstrap por wallet address. La rehidratacion se vuelve wallet-aware y ocurre solo despues de resolver la wallet actual.

## Componentes

### `front/src/hooks/useWallet.ts`

- Sigue siendo la fuente de verdad del estado de conexion.
- Debe exponer un estado suficientemente estable para diferenciar:
  - wallet resuelta y conectada con `address`
  - wallet resuelta y desconectada
- El cambio de wallet debe ser observable por la capa de chat para reinicializar o recargar el scope correcto.

### `front/src/stores/chatStore.ts`

- Debe evolucionar desde persistencia global minima a persistencia scopiada por wallet.
- Modelo persistido sugerido:

```ts
type PersistedWalletChatBootstrap = {
  schemaVersion: number;
  sessionsByWallet: Record<string, { sessionId: string | null; updatedAt: string }>;
};
```

Reglas:

- La clave persistida puede seguir siendo unica, pero su contenido debe estar indexado por wallet normalizada; o puede migrarse a claves namespaced por wallet. Cualquiera de las dos opciones es valida si evita leakage cross-wallet.
- El estado runtime debe separar:
  - `activeWalletAddress`
  - `sessionId`
  - `messages`
  - `pendingProposal`
  - estado de hidratacion
- Desconectar wallet debe vaciar el runtime activo sin borrar necesariamente los bootstraps persistidos de otras wallets.
- La migracion debe invalidar el viejo `sessionId` global para impedir que siga rehidratando sesiones de otra wallet.

### `front/src/hooks/useAgentMessage.ts`

- Debe esperar a que la wallet este resuelta antes de intentar hidratar.
- Debe leer la referencia persistida solo para la wallet conectada.
- Debe invocar `getHistory(sessionId, userAddress)` cuando haya wallet conectada.
- Si el backend responde `session_not_found`, debe limpiar la referencia persistida de esa wallet y resetear el estado runtime.
- Debe reaccionar a wallet switch:
  - abortar hidrataciones en curso de la wallet previa
  - limpiar el transcript visible
  - cargar el bootstrap de la nueva wallet si existe
- Debe seguir enviando `user_address` en `user_message`.
- Debe propagar `user_address` en `function_approve`, `function_reject` y `function_result` para alinear enforcement de todas las acciones sensibles.

### `front/src/lib/api/client.ts`

- Debe extender el contrato cliente para que `get_history` reciba `user_address` opcional y lo envie cuando exista wallet conectada.
- Debe alinear tambien `function_approve`, `function_reject` y `function_result` con el contrato backend si hoy no incluyen `user_address`.

Contrato propuesto:

```ts
type ChatRequest =
  | { type: 'get_history'; session_id: string; user_address?: string }
  | { type: 'function_approve'; session_id: string; user_address?: string; action_hash?: string }
  | { type: 'function_reject'; session_id: string; user_address?: string; reason?: string }
  | {
      type: 'function_result';
      session_id: string;
      user_address?: string;
      tx_signature: string;
      status: 'submitted' | 'confirmed' | 'failed';
      error_message?: string;
    };
```

### `app/api/chat/route.ts`

- Sigue siendo proxy del frontend al backend.
- No requiere cambio de comportamiento propio si ya forwardea el body completo, pero debe preservarse el nuevo `user_address` en requests de hidracion y acciones.

### `back/services/chat.ts`

- `handleGetHistory` debe tratar `user_address` como obligatorio para sesiones con `session.userAddress`.
- Si `session.userAddress` existe y `request.user_address` falta o no coincide, debe responder `session_not_found`.
- `hasSessionWalletMismatch` puede mantenerse como helper, pero la semantica debe cubrir tanto mismatch como omission para sesiones wallet-bound.
- `function_approve`, `function_reject` y `function_result` deben usar el mismo criterio de acceso por wallet, no solo `get_history`.
- `handleUserMessage` puede conservar la logica actual de crear sesion nueva al detectar mismatch, porque protege continuidad sin mezclar wallets.

### `back/services/chatSessionStore.ts`

- `SessionState.userAddress` sigue siendo el campo fuente para ownership de sesion.
- No se requiere indice multi-sesion por usuario para esta feature.

## Flujos

### Rehidratacion con refresh

1. La app resuelve wallet actual.
2. Si no hay wallet conectada, no hidrata historial.
3. Si hay wallet conectada, busca bootstrap persistido para esa wallet.
4. Si existe `sessionId`, llama `get_history` con `session_id` y `user_address`.
5. Si backend responde OK, hidrata transcript y propuesta pendiente.
6. Si backend responde `session_not_found`, limpia bootstrap de esa wallet y deja el chat en estado inicial.

### Wallet switch

1. Detectar cambio de `activeWalletAddress`.
2. Cancelar cualquier hidratacion en vuelo asociada a la wallet previa.
3. Limpiar inmediatamente `messages`, `pendingProposal` y `sessionId` visibles.
4. Cargar bootstrap de la wallet nueva.
5. Hidratar solo si la wallet nueva tiene `sessionId` persistido valido.

### Wallet disconnect

1. Detectar estado desconectado.
2. Limpiar estado runtime del chat.
3. No hidratar hasta que una wallet vuelva a conectarse.
4. Mantener bootstraps persistidos por wallet solo como referencias futuras, nunca como estado activo desconectado.

## Decisiones tecnicas

- Se adopta una sola sesion activa por wallet address.
- Se invalida el viejo `sessionId` global compartido durante la migracion de persistencia.
- El backend devuelve `session_not_found` tambien ante omission de `user_address` en sesiones wallet-bound para evitar filtrado de existencia.
- Full multi-session index/listing queda explicitamente fuera de alcance hasta tener una fuente durable o un indice server-side por usuario.

## Riesgos

- Carrera de hidratacion: el chat puede intentar hidratar antes de conocer la wallet actual y mostrar datos equivocados.
- Leakage visual: si el cleanup en wallet switch ocurre despues de renderizar la nueva wallet, pueden verse mensajes de la wallet previa por un frame.
- Ruptura de compatibilidad: la migracion del storage debe descartar referencias viejas sin dejar al usuario en un estado corrupto.
- Enforcement incompleto: si `get_history` se corrige pero `function_approve` o `function_result` no propagan `user_address`, persiste una via de acceso indebida.
- Session fixation: el `session_id` actual es debil, pero este documento lo trata solo como riesgo residual y no como alcance de esta feature.

## Verificacion esperada

- Tests frontend del store para:
  - migracion desde clave global previa
  - persistencia por wallet
  - cleanup en switch/disconnect
- Tests del hook para:
  - no hidratar antes de resolver wallet
  - hidratar Wallet A correctamente
  - no mostrar A al cambiar a Wallet B
  - limpiar bootstrap al recibir `session_not_found`
- Tests backend para:
  - `get_history` OK con wallet correcta
  - `get_history` responde `session_not_found` con wallet distinta
  - `get_history` responde `session_not_found` si falta `user_address` y la sesion es wallet-bound
  - approve/reject/result rechazan mismatch
- Validacion manual:
  - conectar Wallet A, chatear, refrescar y verificar rehidratacion de A
  - cambiar a Wallet B y verificar ausencia de mensajes de A
  - desconectar wallet y verificar reset del chat activo
