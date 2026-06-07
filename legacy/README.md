# `legacy/`

Esta carpeta es un **archivo aislado** del Compass anterior (el chat-app con `/api/chat`, Dynamic wallet, sidebar, proposals card, tool-call orchestration y endpoints de soporte para esa UI). Vive acá únicamente como referencia.

## Reglas

1. **El árbol principal no importa nada de `legacy/`.** ESLint enforza esto con `no-restricted-imports`. Si vés una violación, no la silencies; o subís la dependencia al árbol principal con un refactor explícito (rara vez correcto) o ajustás el código nuevo para no necesitarla.
2. **`legacy/` puede importarse a sí misma** dentro de la carpeta. Sus propios re-exports (por ejemplo `legacy/back/services/upstream.ts`) son self-contained.
3. **No agregar features nuevas acá.** Si necesitás algo nuevo, va al árbol principal alineado al norte Compass MCP Guard (ver `docs/PRODUCT_CONSTITUTION.md`).
4. **No borrar archivos en bulk.** El sentido de `legacy/` es preservar la referencia. Limpiezas masivas requieren su propia wave aprobada.
5. **Secretos no van acá.** `credentials` y `dynamic_private_key` siguen en `.gitignore`. Su rotación, si hace falta, ocurre en una wave aparte.

## Layout

```txt
legacy/
├── README.md              # este archivo
├── app/                   # app/home, app/dynamic-reset y app/api/** del chat-app
├── back/                  # chat.ts, providers viejos (Jupiter/Birdeye/Helius/RiskScore/Dynamic), tools del chat
│                          # incluye back/README.md y back/.env.example anteriores
├── docs/                  # specs de features del producto viejo y docs transversales obsoletas
├── front/                 # toda la UI vieja (src + docs + README)
├── learning-explanations/
├── public/                # solo architecture-explainer.html (marca anterior “Wallet Copilot”)
├── scripts/               # scripts ad-hoc (bootstrap-conditional-devnet, test-chat, etc.)
└── sdd/                   # back/sdd/, sdd/wip, sdd/done, openspec/ consolidados acá
```

## Cómo correr el legacy si hace falta

Esta carpeta no se compila por el build principal. Si necesitás inspeccionar comportamiento del producto anterior:

- **Tests**: usar el runner aparte
  ```bash
  npm run test:legacy
  ```
- **Lint**: usar el runner aparte
  ```bash
  npm run lint:legacy
  ```
- **Servidor Next con el chat-app**: no soportado en esta forma. El árbol principal sirve solo la landing en `/`. Para resucitar la app vieja completa habría que mover los archivos de vuelta (o configurar un Next aparte), lo cual no es el objetivo de esta carpeta.

## Riesgos conocidos

- `credentials` y `dynamic_private_key` viven todavía en disco (no en git, ya están en `.gitignore`). Si alguna vez contuvieron llaves reales, deberían rotarse. Decisión actual: **no rotar en esta wave**; queda en backlog.
- Las CTAs de `landing.html` que antes apuntaban a `/home` fueron reescritas temporalmente a `#flow` con un `<!-- TODO -->` para reactivarlas cuando exista el entrypoint MCP Guard.
- `back/.env.example` viejo (con DYNAMIC/BIRDEYE/HELIUS/JUPITER/OPENAI) vive en `legacy/back/.env.example`. El árbol principal tiene su propio `.env.example` minimalista para el MCP Guard.

## Cómo desaparece esto

`legacy/` puede irse el día que el Compass MCP Guard tenga su propio entrypoint y nadie consulte la referencia. No hay deadline. La regla operativa hasta entonces: tratarlo como read-only.
