# Technical Spec: Chat Session History

## Arquitectura propuesta

Implementar una capa de persistencia local sobre el store de chat de Zustand en `FRONT/src/stores/chatStore.ts`, siguiendo el patron ya usado en `settingsStore`. La persistencia se limita al frontend y modela conversaciones como snapshots UI versionadas.

## Componentes

- `chatStore`
  - Evoluciona de estado de sesion unica en memoria a store con:
    - `activeConversationId`
    - `conversationsById`
    - `conversationOrder`
    - estado derivado de la conversacion activa
    - `schemaVersion`
  - Usa `persist` de Zustand con `partialize`, `version` y `migrate`.
- `useAgentMessage`
  - Sigue enviando `session_id` y aprobaciones al backend.
  - Cuando llega evento SSE `session`, asocia el `sessionId` a la conversacion activa.
  - Antes de aprobar/rechazar valida estado local de sesion y wallet.
- `ChatHistoryList`
  - Lee conversaciones reales del store.
  - Permite seleccionar, borrar una conversacion y limpiar historial.
- UI de chat/propuesta
  - Renderiza mensajes rehidratados.
  - Marca propuestas rehidratadas como `expired` o `wallet_mismatch` a nivel UI cuando no son accionables.

## Modelo de datos sugerido

```ts
type PersistedConversation = {
  id: string;
  sessionId: string | null;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  walletAddressAtCreation: string | null;
  lastWalletAddress: string | null;
  hasPendingProposal: boolean;
  pendingProposalPreview: {
    toolName?: string;
    createdAt?: string;
  } | null;
};
```

Notas:

- `pendingProposal` sensible no debe rehidratarse como fuente de verdad operativa.
- La UI puede reconstruir un estado visual minimo desde `messages` y `hasPendingProposal`, pero la accion de aprobar requiere una sesion backend valida y wallet compatible.
- Conviene agregar metadatos locales para estado derivado de accionabilidad:
  - `sessionStatus`: `unknown | active | expired`
  - `walletStatus`: `match | mismatch | unknown`

## Contratos y comportamiento

- Crear una nueva conversacion cuando el usuario inicia chat sin conversacion activa valida.
- Mantener `welcomeMessage` como bootstrap de una conversacion nueva, no como mensaje duplicado al rehidratar.
- Derivar `title` en cada conversacion desde el primer mensaje de usuario; fallback a propuesta o texto generico.
- Pruning:
  - migrar por `schemaVersion`
  - eliminar conversaciones corruptas/incompatibles
  - limitar cantidad maxima o tamaño total si el implementer lo considera necesario, sin cambiar alcance funcional
- Sesion expirada:
  - si `/api/chat` responde con nueva sesion para un historial viejo, esa interaccion debe continuar en una nueva conversacion o actualizar explicitamente el hilo local, evitando mezclar aprobaciones viejas con una sesion nueva
- Wallet mismatch:
  - si `currentWallet !== walletAddressAtCreation` o `lastWalletAddress`, bloquear aprobacion/rechazo y acciones de envio desde esa conversacion

## Riesgos

- Rehidratar `pendingProposal` directamente puede habilitar una aprobacion stale contra una sesion backend inexistente.
- Duplicar el proposal en `messages[]` y en `pendingProposal` puede desincronizar UI si no se define una sola fuente rehidratable.
- Mezclar un `sessionId` expirado con mensajes nuevos puede producir conversaciones ambiguas o aprobaciones sobre el hilo incorrecto.
- Persistir demasiado payload en `localStorage` puede causar fallos de cuota o degradacion.

## Verificacion esperada

- `npm test -- --runInBand`
- `npm run lint`
- tests unitarios del store para:
  - rehidratacion
  - migracion/versionado
  - delete/clear history
  - guardas por sesion expirada y wallet mismatch
- tests de componentes/hooks para:
  - `ChatHistoryList` real
  - restauracion de conversacion activa
  - bloqueo de aprobacion tras refresh con sesion expirada
