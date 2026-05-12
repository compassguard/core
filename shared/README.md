# shared

Tipos, constantes y utilidades que pueden ser usados tanto por `front/` como por `back/`.

## Regla principal

`shared/` debe ser seguro para ambos runtimes:

- sin acceso a `process.env`;
- sin imports de Node-only (`fs`, `crypto` de Node, etc.) salvo que el módulo esté explícitamente marcado server-only;
- sin imports de React/UI;
- sin clientes HTTP con secrets;
- sin side effects al importar.

## Cuándo usar `shared/`

| Caso | Ubicación recomendada |
|---|---|
| Tipo usado por frontend y backend | `shared/` |
| Constante pública usada en ambos lados | `shared/` |
| Helper puro sin dependencia de runtime | `shared/` |
| Tipo solo de UI/chat rendering | `front/src/types/` |
| Tipo interno de servicio/backend | `back/services/*` |
| Config con secrets o env vars | `back/services/*` o config server-side |

## Import

Alias disponible:

```ts
import type { Example } from '@shared/example';
```

El alias está definido en `tsconfig.json` y en las configs de Vitest.

## Checklist antes de agregar algo

- [ ] ¿Lo usan ambos lados? Si no, dejalo en `front/` o `back/`.
- [ ] ¿Es puro y sin side effects?
- [ ] ¿No filtra detalles server-side al browser?
- [ ] ¿Tiene nombre estable y fácil de importar?
- [ ] ¿Necesita tests compartidos o alcanza con tests del consumidor?
