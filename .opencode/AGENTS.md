# Compass MCP Guard — opencode Project Instructions

## Project Context

Compass is migrating into **Compass MCP Guard**: an execution firewall for AI agents operating on Solana.

The canonical product source is `docs/PRODUCT_CONSTITUTION.md`.

High-level active architecture:

- `app/`: minimal Next.js entrypoints for the public landing, `/landing` redirect, and `/launch` WIP page.
- `back/`: MCP Guard server-side services, execution gateway, policy, transfer/swap/conditional guards, audit, on-chain approval, shared providers, and Anchor programs.
- `legacy/`: historical snapshot of the old chat/wallet product. The active tree must not import from `legacy/`.

## Documentation Source Of Truth

- Use `docs/` as the only canonical documentation tree for product specs, proposals, technical designs, task plans, and verification notes.
- Do not create or mirror OpenSpec artifacts in `openspec/` unless the user explicitly asks to migrate the repository to OpenSpec.
- New feature specs must live under `docs/<feature-name>/functional-spec.md`, `technical-spec.md`, and `task.json`.
- Continue an existing feature folder instead of creating a second source of truth.

## Guardrail Principle

No critical operation should execute without passing through Compass guardrails first.

If validation fails, return a clear reason and suggested action: block, request stronger confirmation, or retry with corrected conditions.

## Legacy Isolation

- Do not import from `legacy/` in active `app/`, `back/`, `shared/`, `docs/`, or new scripts.
- If a legacy capability is still needed, extract it into a new active-tree module with its own types/contracts.
- Keep `legacy/` excluded from main lint/test/typecheck flows unless working explicitly on legacy.

## Branch Policy

- Migration work must not merge directly into `main` until explicitly approved.
- Use `release/compass_migration` as the integration branch.
- Use `feature/wave-<n>-<description>` branches for wave/sub-feature work.
- Feature wave branches should branch from and merge back into `release/compass_migration`.

## GitHub Account

- The correct GitHub account for pushing this project is `ram4_dev`.
- `gh` can sometimes be active as `rcarnicer_meli` because credentials are shared in this environment.
- In this environment, `gh auth status` may show that account as `ram4-dev`.
- If push fails with permissions against `ram4-dev/solana_hackathon`, run `gh auth switch -u ram4-dev` and retry the push.

## Type Convention

Canonical types, interfaces, enums/constants, and shared contracts must live in files separate from behavior/business logic.

Prefer dedicated files like `*Types.ts`, `*Contracts.ts`, or `*Schema.ts` for contracts. Business logic should import those types instead of defining them inline.
