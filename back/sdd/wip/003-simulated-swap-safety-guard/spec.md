# 003 - Simulated Swap Safety Guard

## Status
WIP

## Goal

Implement a swap safety feature for agent-initiated swaps without integrating Jupiter for the hackathon MVP.

The swap flow must be simulated on devnet/off-chain, while still demonstrating the complete security framework: intent parsing, policy validation, quote validation, confirmation, on-chain approval, and auditability.

## Scope

This spec covers simulated swap intents such as:

```txt
Swap 5 USDC to SOL
Buy SOL with 10 USDC
Swap 50 USDC to SOL only if I receive at least 0.3 SOL
```

The MVP does not perform a real Jupiter swap. Instead, it uses a controlled simulated quote provider.

## Out of Scope

- Real Jupiter integration.
- Mainnet swaps.
- Custom DEX implementation.
- Liquidity pools.
- Yield/staking strategies.
- Custody of private keys.

## User Story

As a user, I want the agent to evaluate whether a proposed swap is safe and economically acceptable before I approve anything.

## Design Decision

For the hackathon, swaps run in:

```txt
DEVNET_SIMULATION_MODE
```

This means:

```txt
- The backend simulates a quote.
- The policy engine validates the quote.
- The user can approve the simulated swap action on-chain.
- The app demonstrates how the flow would work with a real swap provider later.
- No Jupiter dependency is required for the demo.
```

## High-Level Flow

```txt
User natural-language intent
→ intent parser detects swap action
→ backend extracts from_token, to_token, amount_in, optional min_out
→ simulated quote provider returns quote
→ swap policy validation
→ decision: ALLOW / WARN / REJECT
→ if ALLOW/WARN, create pending action
→ frontend shows quote preview
→ user confirms
→ on-chain action approval is created through AgentActionGuard
→ simulated execution is marked complete
→ audit log is stored
```

## Required Backend Components

### Swap Intent Parser

Extracts:

```json
{
  "action": "swap",
  "from_token": "USDC",
  "to_token": "SOL",
  "amount_in": "50",
  "min_amount_out": "0.3"
}
```

`min_amount_out` is optional.

### Simulated Quote Provider

Returns deterministic quote data.

Example:

```json
{
  "provider": "simulated_devnet_quote",
  "from_token": "USDC",
  "to_token": "SOL",
  "amount_in": "50",
  "estimated_amount_out": "0.31",
  "slippage_bps": 50,
  "price_impact_bps": 80,
  "expires_at": "2026-05-09T18:00:00Z"
}
```

The simulated provider must be deterministic for demo and test purposes.

Suggested implementation:

```txt
- Use fixed token prices from local config.
- Apply fixed simulated slippage.
- Apply fixed simulated price impact.
- Return quote expiration.
```

Example local config:

```json
{
  "SOL_USD_PRICE": "160",
  "DEFAULT_SLIPPAGE_BPS": 50,
  "DEFAULT_PRICE_IMPACT_BPS": 80
}
```

### Swap Policy Engine

Validates:

```txt
- from_token is allowed.
- to_token is allowed.
- amount_in is under max swap amount.
- slippage is under max_slippage_bps.
- price impact is under max_price_impact_bps.
- estimated output is greater than or equal to user's min_amount_out.
- provider is allowed.
- quote is not expired.
```

Example policy:

```json
{
  "allowed_swap_provider": "simulated_devnet_quote",
  "allowed_input_tokens": ["USDC", "SOL"],
  "allowed_output_tokens": ["SOL", "USDC"],
  "max_swap_usd": 100,
  "max_slippage_bps": 100,
  "max_price_impact_bps": 200,
  "requires_confirmation": true
}
```

## Decision Engine

Example ALLOW response:

```json
{
  "decision": "ALLOW_WITH_CONFIRMATION",
  "risk_level": "low",
  "reasons": [
    "Input token is allowed",
    "Output token is allowed",
    "Amount is within policy",
    "Simulated output is above user's minimum",
    "Slippage is within policy",
    "Price impact is within policy"
  ],
  "requires_confirmation": true
}
```

Example REJECT response:

```json
{
  "decision": "REJECT",
  "risk_level": "high",
  "reasons": [
    "Simulated output is below user's minimum amount"
  ],
  "requires_confirmation": false
}
```

## SSE Contract

The backend must send the simulated swap preview as a normal assistant message with metadata serialized as JSON string.

```txt
event: message
data: {
  "type": "assistant_message",
  "content": "I simulated this swap. You would receive approximately 0.31 SOL for 50 USDC. Please review before approving.",
  "metadata": "{\"requires_confirmation\":true,\"confirmation_id\":\"conf_swap_123\",\"function_tool\":{\"display_name\":\"Simulated Swap\",\"technical_name\":\"simulate_swap\",\"params\":{\"from_token\":\"USDC\",\"to_token\":\"SOL\",\"amount_in\":\"50\",\"estimated_amount_out\":\"0.31\",\"min_amount_out\":\"0.3\"}},\"risk_level\":\"low\",\"policy_result\":\"allowed_with_confirmation\"}"
}
```

## Pending Action Store

The backend must persist:

```json
{
  "confirmation_id": "conf_swap_123",
  "conversation_id": "conv_123",
  "action_type": "simulate_swap",
  "action_hash": "sha256_canonical_params_and_quote",
  "params": {
    "from_token": "USDC",
    "to_token": "SOL",
    "amount_in": "50",
    "estimated_amount_out": "0.31",
    "min_amount_out": "0.3",
    "slippage_bps": 50,
    "price_impact_bps": 80
  },
  "status": "pending",
  "expires_at": "2026-05-09T18:00:00Z"
}
```

## On-Chain Integration

The user must create an on-chain approval through `AgentActionGuard` before the simulated swap is marked as accepted.

The approval must contain:

```txt
user
agent
action_hash
action_type = SIMULATED_SWAP
input_amount
min_output_amount
max_slippage_bps
expires_at
executed=false
revoked=false
```

The program does not perform the swap.

The program proves the user approved the exact simulated swap parameters.

## Security Rules

### Hard Reject

Reject if:

```txt
- Token is not allowed.
- Amount exceeds max swap policy.
- Slippage exceeds max_slippage_bps.
- Price impact exceeds max_price_impact_bps.
- Estimated output is lower than min_amount_out.
- Quote expired.
- Confirmation action hash does not match pending quote.
```

### Warning

Warn if:

```txt
- Token is allowed but marked as experimental.
- Quote is close to min_amount_out threshold.
- Simulated price impact is near max allowed.
```

## Acceptance Criteria

- Natural-language swap intent is parsed.
- Swap quote is simulated deterministically.
- Swap policy is applied to simulated quote.
- Backend returns ALLOW/WARN/REJECT with reasons.
- No real Jupiter call is required.
- No real swap transaction is executed.
- User can approve the simulated swap on-chain.
- Approval is bound to the exact quote/action hash.
- Simulated execution cannot be marked executed without approval.

## Demo Cases

### Case 1: Valid Simulated Swap

```txt
User: Swap 50 USDC to SOL only if I get at least 0.3 SOL
Simulated quote: 0.31 SOL
Result: ALLOW_WITH_CONFIRMATION
```

### Case 2: Output Too Low

```txt
User: Swap 50 USDC to SOL only if I get at least 0.5 SOL
Simulated quote: 0.31 SOL
Result: REJECT
```

### Case 3: Slippage Too High

```txt
Policy max slippage: 100 bps
Simulated quote slippage: 200 bps
Result: REJECT
```

## Future Mainnet Path

After the hackathon, replace the simulated quote provider with:

```txt
Jupiter Quote API
Jupiter Swap API
Real token verification
Real route validation
```

The policy, confirmation, on-chain approval, and audit layers should remain the same.
