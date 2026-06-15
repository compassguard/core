# Compass

Compass is the **execution firewall for AI agents on Solana**.

It sits between AI agents, MCP tools, wallets, and on-chain protocols. Before any sensitive crypto action is signed or executed, Compass validates intent, classifies the tool call, applies policy, simulates or decodes the transaction when needed, asks for human approval when required, and records the decision in an audit trail.

Compass is **not** another AI wallet. Wallets control signing. Compass controls whether an agent action should reach signing at all.

## Source Of Truth

- [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md)

## Repository Shape

```txt
.
├── app/                  # Next.js entrypoints for the public landing
├── back/
│   ├── services/         # Gateway, policy, guards, audit, MCP proxy, providers
│   └── solana/           # Anchor programs
├── docs/                 # Product docs and active cross-cutting notes
├── public/               # Landing assets
├── scripts/              # Small repo utilities
├── shared/               # Placeholder for shared contracts
├── landing.html          # Public landing page
└── launch.html           # Temporary WIP app page
```

## Runtime Boundary

```txt
Browser request -> app/route.ts -> landing.html
Browser request -> app/launch/route.ts -> launch.html

AI agent / MCP client -> Compass MCP proxy -> policy/audit/guard services -> signer boundary
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm install --registry=https://registry.npmjs.org` | Install dependencies. |
| `npm run dev` | Run the Next.js app. |
| `npm run build` | Production build. |
| `npm test` | Run the active backend test suite. |
| `npm run test:watch` | Watch the active backend test suite. |
| `npm run lint` | Lint `app` and `back/services`. |
| `npm run mcp:dev` | Run the Compass MCP server. |

## Security Rules

- Critical operations must pass backend guardrails before signing/execution.
- `sign_and_send_transaction` style flows must be denied unless Compass built and approved the transaction.
- Missing evidence, unsafe policy state, or unverifiable high-risk actions must fail closed.
- The Compass backend must not hold or expose user private keys.
