# shared

Types, constants, and pure utilities that are safe to use across Compass MCP Guard runtimes.

`shared/` is currently a placeholder for future cross-runtime contracts. Most canonical backend contracts still live beside their behavior in `back/services/*Contracts.ts` until a browser/MCP client needs them.

## Rule

Anything in `shared/` must be safe for both server-side and future client-side consumers:

- no `process.env` access;
- no Node-only imports (`fs`, Node `crypto`, etc.) unless the module is explicitly server-only;
- no React/UI imports;
- no HTTP clients that require secrets;
- no side effects at import time.

## When to use `shared/`

| Case | Recommended location |
|---|---|
| Type used by both backend and a future UI/MCP client | `shared/` |
| Public constant used across runtimes | `shared/` |
| Pure helper with no runtime dependency | `shared/` |
| Backend-only service contract | `back/services/*Contracts.ts` |
| UI-only type for a future frontend | future UI tree, not `back/` |
| Config with secrets or env vars | server-side config under `back/services/` |

## Import

Alias available from the main tree:

```ts
import type { Example } from '@shared/example';
```

The alias is defined in `tsconfig.json`. Vitest configs can add it back only when tests need it.

## Checklist before adding something

- [ ] Is it actually used by more than one runtime?
- [ ] Is it pure and side-effect free?
- [ ] Does it avoid leaking server-side implementation details?
- [ ] Does it have a stable, contract-like name?
- [ ] Does it need dedicated tests, or is consumer coverage enough?
