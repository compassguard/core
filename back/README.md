# `back/`

Backend for **Compass MCP Guard**: services, contracts, policy engine, guardrails, audit, MCP proxy, and Anchor programs.

## Layout

```txt
back/
├── services/
│   ├── guardrail/
│   │   ├── execution/
│   │   │   ├── executionGateway.ts
│   │   │   └── executionGatewayContracts.ts
│   │   ├── policy/
│   │   │   ├── defaultPolicy.ts
│   │   │   ├── loadPolicy.ts
│   │   │   ├── policyEngine.ts
│   │   │   ├── policyContracts.ts
│   │   │   ├── policyEvaluationResult.ts
│   │   │   └── policySchema.ts
│   │   └── router/
│   ├── mcp/
│   ├── transferGateway.ts
│   ├── swapGateway.ts
│   ├── conditionalGateway.ts
│   ├── walletSafetyValidation.ts
│   ├── onchainApproval.ts
│   └── __tests__/
└── solana/
    ├── agent-action-guard/
    └── conditional-escrow-buy/
```

## Rules

1. Types stay separate from behavior in `*Contracts.ts` or equivalent files.
2. Critical operations pass through gateway/policy before transaction construction or signing.
3. Audit metadata must not include raw transactions, prompts, or secrets.

## Commands

```bash
npm run test:back
npm run lint
npx tsc --noEmit
```
