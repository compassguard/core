# T8 Spec — Documental validation

> Alineado a `front/docs/frontend-spec.md`.

## Objective

Validar que la documentación y la implementación futura no reintroduzcan contradicciones.

## Requirements

- Revisar que `front/docs/frontend-spec.md` sea el SSoT citado por los demás docs.
- Verificar que no se documenten provider keys públicas ni APIs externas desde frontend.
- Verificar que cualquier mención de tx build/sign/submit esté asignada al backend/agent.
- En esta tarea documental no ejecutar tests, build ni lint.

## Acceptance

- Docs de `front/` no contradicen el SSoT.
- Cualquier documento histórico queda marcado como superseded.
