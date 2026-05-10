# Project Codex Instructions

## Specs por feature

Las specs SDD de este repo van separadas por feature bajo `docs/<nombre-feature>/`.

Estructura obligatoria para una feature:

- `docs/<nombre-feature>/functional-spec.md`
- `docs/<nombre-feature>/technical-spec.md`
- `docs/<nombre-feature>/task.json`

Reglas:

- Usar `kebab-case` para `<nombre-feature>`.
- No crear nuevas specs de feature directamente en la raiz de `docs/`.
- Antes de crear una spec, buscar si ya existe una carpeta de esa feature y continuar ahi.
- Reservar `docs/` raiz para documentacion transversal, indices o documentos historicos existentes.
- En prompts a subagentes SDD, pasar explicitamente la carpeta de destino de la feature.
