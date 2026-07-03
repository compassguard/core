# OpenCode MCP Setup

## Quick Start

Run the installer script to configure OpenCode to use Compass MCP Guard as a local MCP server:

```bash
npm run mcp:install:opencode
```

## What the Installer Does

1. Reads the existing `.opencode/opencode.json` (or creates it if missing)
2. Adds or updates the `mcp.compass` entry with the local MCP server command
3. Preserves `$schema`, `instructions`, and all other existing config fields
4. Creates a timestamped backup before writing (`.opencode/opencode.json.backup-YYYY-MM-DDT...`)
5. Never writes secrets, API keys, or signer credentials to config

## Dry Run

To preview the planned changes without writing:

```bash
npm run mcp:install:opencode -- --dry-run
```

## Config Shape

The installer writes the following shape to `.opencode/opencode.json`:

```json
{
  "mcp": {
    "compass": {
      "type": "local",
      "command": ["npm", "run", "--silent", "mcp:dev"],
      "enabled": true,
      "env": {}
    }
  }
}
```

## Restart Required

OpenCode does **not** hot-reload config changes. After running the installer, restart OpenCode by closing and reopening your editor/terminal.

## Environment Variables

When the MCP server starts via `npm run mcp:dev`, it automatically loads
variables from the repo-root `.env` file into `process.env`. Existing
environment variables are never overridden. Secret values are masked in
startup logs.

The Compass MCP server reads these environment variables at runtime:

### LLM Judge

| Variable | Purpose | Default |
|---|---|---|
| `COMPASS_LLM_DECISION_ENABLED` | Enables LLM judge calls | `false` |
| `COMPASS_LLM_PROVIDER` | Provider key | `opencode-go` |
| `COMPASS_LLM_MODEL` | Model name | `kimi-k2.5` |
| `COMPASS_LLM_BASE_URL` | OpenCode Go chat completions endpoint | `https://opencode.ai/zen/go/v1/chat/completions` |
| `COMPASS_LLM_API_KEY` | Optional provider credential | unset |
| `COMPASS_LLM_TIMEOUT_MS` | Judge timeout in ms | `3000` |

The LLM judge is **disabled by default**. To enable it, set these environment variables in your shell or `.env` file — the installer never writes them to config.

### Local Signer

| Variable | Purpose | Default |
|---|---|---|
| `COMPASS_LOCAL_SIGNER_ENABLED` | Enables local keypair signer | unset (false) |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` | Base58-encoded secret key (original env var) | unset |
| `COMPASS_LOCAL_SIGNER_SECRET_KEY` | Base58-encoded secret key (alias, preferred shorter name) | unset |
| `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` | Expected public key; signer fails if it does not match the derived address | unset |

The signer resolves `COMPASS_LOCAL_SIGNER_SECRET_KEY_B58` first, then `COMPASS_LOCAL_SIGNER_SECRET_KEY`. When `COMPASS_LOCAL_SIGNER_PUBLIC_KEY` is set, it must match the address derived from the secret key — if they differ, the signer returns `LOCAL_SIGNER_PUBLIC_KEY_MISMATCH` instead of silently using the wrong key.

## Troubleshooting

- **Config not picked up?** Restart OpenCode completely.
- **MCP server fails to start?** Run `npm run mcp:dev` directly to check for errors.
- **Need to revert?** The installer creates a backup file before each write. Rename it to `opencode.json` to revert.
