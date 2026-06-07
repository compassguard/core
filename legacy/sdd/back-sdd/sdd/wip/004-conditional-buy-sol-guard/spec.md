# 004 - Conditional Buy SOL Guard

## Status
WIP

## Goal

Implement a safety feature that lets the user define conditional SOL buy intents, while keeping execution controlled by policies, quote validation, user confirmation, and on-chain approval.

For hackathon MVP, the buy action is simulated and validated on devnet. It does not use Jupiter.

## Scope

This spec covers intents such as:

```txt
Buy SOL with 50 USDC only if I receive at least 0.3 SOL
Buy SOL if SOL is below 130 USD
Use 10 USDC to buy SOL only if the quote is good enough
```

Supported MVP mode:

```txt
DEVNET_SIMULATION_MODE
```

## Out of Scope

- Real Jupiter integration.
- Real limit orders.
- Automated execution without user confirmation.
- Mainnet execution.
- Oracle integration for MVP.
- Custody of user funds.

## User Story

As a user, I want the agent to help me define safe buy conditions for SOL, but I want the system to execute or simulate only when the exact condition is satisfied.

## High-Level Flow

```txt
User natural-language conditional buy intent
→ intent parser detects buy_sol action
→ backend extracts input token, input amount, condition, min output
→ simulated price/quote provider evaluates condition
→ policy engine validates limits
→ decision: ALLOW / WAIT / REJECT
→ if ALLOW, create pending action
→ frontend displays condition and quote preview
→ user confirms
→ on-chain approval is created through AgentActionGuard
→ simulated execution is marked complete
→ audit log is stored
```

## Supported Conditions

### Minimum Output Condition

```txt
Buy SOL with 50 USDC only if I receive at least 0.3 SOL
```

Parsed as:

```json
{
  "action": "buy_sol",
  "input_token": "USDC",
  "input_amount": "50",
  "min_sol_out": "0.3"
}
```

### Price Threshold Condition

```txt
Buy SOL with 50 USDC if SOL is below 130 USD
```

Parsed as:

```json
{
  "action": "buy_sol",
  "input_token": "USDC",
  "input_amount": "50",
  "condition": {
    "type": "price_below",
    "asset": "SOL",
    "price_usd": "130"
  }
}
```

For MVP, the price can come from a simulated local config.

## Simulated Market Provider

Returns deterministic price and quote values.

Example:

```json
{
  "provider": "simulated_devnet_market",
  "sol_usd_price": "125",
  "input_token": "USDC",
  "input_amount": "50",
  "estimated_sol_out": "0.40",
  "slippage_bps": 50,
  "price_impact_bps": 80,
  "expires_at": "2026-05-09T18:00:00Z"
}
```

Recommended local config:

```json
{
  "SIMULATED_SOL_USD_PRICE": "125",
  "DEFAULT_SLIPPAGE_BPS": 50,
  "DEFAULT_PRICE_IMPACT_BPS": 80
}
```

## Decision Types

```txt
ALLOW_WITH_CONFIRMATION
WAIT_CONDITION_NOT_MET
REJECT
```

### ALLOW_WITH_CONFIRMATION

Returned when:

```txt
- Policy allows the action.
- Simulated quote satisfies min output.
- Price condition is met.
- Slippage and price impact are acceptable.
```

### WAIT_CONDITION_NOT_MET

Returned when:

```txt
- The intent is valid.
- Policy allows the action.
- The market condition is not currently met.
```

For MVP, the system does not run a background job. It only returns WAIT.

### REJECT

Returned when:

```txt
- Token is not allowed.
- Amount exceeds policy.
- Slippage is above limit.
- Price impact is above limit.
- Intent is unsafe or malformed.
```

## Policy Engine

Example policy:

```json
{
  "allowed_actions": ["buy_sol"],
  "allowed_input_tokens": ["USDC"],
  "max_buy_usd": 100,
  "max_slippage_bps": 100,
  "max_price_impact_bps": 200,
  "requires_confirmation": true,
  "allow_conditional_actions": true
}
```

## SSE Contract

When condition is met:

```txt
event: message
data: {
  "type": "assistant_message",
  "content": "Your SOL buy condition is currently met. You would receive approximately 0.40 SOL for 50 USDC. Please review before approving.",
  "metadata": "{\"requires_confirmation\":true,\"confirmation_id\":\"conf_buy_sol_123\",\"function_tool\":{\"display_name\":\"Conditional SOL Buy\",\"technical_name\":\"conditional_buy_sol\",\"params\":{\"input_token\":\"USDC\",\"input_amount\":\"50\",\"estimated_sol_out\":\"0.40\",\"condition\":{\"type\":\"price_below\",\"asset\":\"SOL\",\"price_usd\":\"130\"}}},\"risk_level\":\"low\",\"policy_result\":\"allowed_with_confirmation\"}"
}
```

When condition is not met:

```json
{
  "type": "assistant_message",
  "content": "Your buy condition is not met right now. I will not create an approval or execution request.",
  "metadata": "{\"requires_confirmation\":false,\"decision\":\"WAIT_CONDITION_NOT_MET\",\"reasons\":[\"Simulated SOL price is above the requested threshold\"]}"
}
```

## Pending Action Store

When condition is met and confirmation is required, persist:

```json
{
  "confirmation_id": "conf_buy_sol_123",
  "conversation_id": "conv_123",
  "action_type": "conditional_buy_sol",
  "action_hash": "sha256_canonical_buy_params_and_quote",
  "params": {
    "input_token": "USDC",
    "input_amount": "50",
    "estimated_sol_out": "0.40",
    "min_sol_out": "0.3",
    "condition": {
      "type": "price_below",
      "asset": "SOL",
      "price_usd": "130"
    },
    "slippage_bps": 50,
    "price_impact_bps": 80
  },
  "status": "pending",
  "expires_at": "2026-05-09T18:00:00Z"
}
```

## On-Chain Integration

This feature must create an approval in `AgentActionGuard` with:

```txt
user
agent
action_hash
action_type = BUY_SOL
input_amount
min_output_amount
max_slippage_bps
expires_at
executed=false
revoked=false
```

The smart contract does not perform the buy.

It proves that the user approved the exact buy condition and simulated quote.

## Security Rules

### Hard Reject

Reject if:

```txt
- input_token is not allowed.
- amount exceeds max_buy_usd.
- slippage exceeds policy.
- price impact exceeds policy.
- min output is impossible under simulated quote.
- action hash mismatch occurs.
- approval is expired or revoked.
```

### Wait

Return WAIT if:

```txt
- price condition is valid but not met.
- min output condition is valid but not met.
```

## Acceptance Criteria

- Natural-language conditional buy intent is parsed.
- Simulated market data is used for hackathon demo.
- Condition can return ALLOW, WAIT, or REJECT.
- On-chain approval is created only when condition is met and user confirms.
- Approval is bound to exact condition and quote hash.
- No Jupiter integration is required.
- No backend signing is allowed.
- User can see reasons for ALLOW/WAIT/REJECT.

## Demo Cases

### Case 1: Price Condition Met

```txt
User: Buy SOL with 50 USDC if SOL is below 130 USD
Simulated SOL price: 125 USD
Result: ALLOW_WITH_CONFIRMATION
```

### Case 2: Price Condition Not Met

```txt
User: Buy SOL with 50 USDC if SOL is below 100 USD
Simulated SOL price: 125 USD
Result: WAIT_CONDITION_NOT_MET
```

### Case 3: Minimum Output Not Met

```txt
User: Buy SOL with 50 USDC only if I get at least 1 SOL
Simulated output: 0.40 SOL
Result: REJECT or WAIT_CONDITION_NOT_MET
```
