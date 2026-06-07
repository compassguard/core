# Research: contextual educational explanations for AI agents, fintech/security workflows, and web3 transaction safety

## Summary
The strongest cross-domain pattern is **contextual, progressive, and actionable explanation**: show a short risk judgment at the exact decision point, reveal deeper evidence only on demand, and always pair the explanation with a recommended next step. Evidence from security-warning research, explainable-AI guidance, consumer-finance regulation, and web3 signing standards suggests that generic warnings create fatigue, while specific reasons, consequence framing, and human-readable transaction context improve comprehension and safer choices.

For a Solana guardrails app, that means the default UX should not be a wall of risk text. It should be a layered system: **headline decision -> why this matters -> what the user can do now -> optional drill-down evidence**, with stronger friction only for higher-risk actions.

## Findings
1. **Progressive disclosure is the right base pattern for risky financial actions** — Progressive disclosure reduces cognitive load by revealing only the information needed for the current step while keeping advanced detail available when needed. This is especially relevant for transaction safety because users need a quick answer first, but power users still need evidence and traceability. [Nielsen Norman Group](https://www.nngroup.com/articles/progressive-disclosure/) [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/progressive-disclosure)

2. **Warnings lose effectiveness when they are frequent, vague, or interruptive without clear consequences** — Security-warning research found that habituation and repeated low-value alerts reduce adherence; users learn to click through when warnings appear too often or fail to distinguish severity. For a guardrails product, this argues for tiered interventions and reserving hard stops for genuinely high-risk cases. [Sunshine et al., "Crying Wolf: An Empirical Study of SSL Warning Effectiveness"](https://www.usenix.org/legacy/events/sec09/tech/full_papers/sunshine.pdf)

3. **Explanations should state specific reasons, not generic model confidence or policy labels** — In consumer-finance contexts, regulators require concrete reasons for adverse decisions rather than vague statements. The same principle transfers well to AI guardrails: "Blocked due to suspicious destination behavior and first-time large transfer" is more useful than "High risk score." [CFPB Circular 2022-03](https://www.consumerfinance.gov/compliance/circulars/consumer-financial-protection-circular-2022-03-adverse-action-notification-requirements-and-artificial-intelligence/)

4. **Explainable AI guidance favors explanation in support of user goals, not explanation for its own sake** — Google’s People + AI guidance emphasizes helping users understand what the system did, why it did it, and what they can do next. For guardrails, the explanation should improve decision quality: confirm, cancel, lower amount, inspect destination, or require a second review. [Google PAIR Guidebook](https://pair.withgoogle.com/guidebook/)

5. **Just-in-time education works better than upfront education for risky flows** — The most effective educational content appears at the moment of decision, tied to the exact action being taken. In human-AI interaction guidance, one of the recurring themes is that systems should provide contextually appropriate information and support when users need it, rather than expecting them to remember earlier instructions. [Microsoft Human-AI Interaction Guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/) [Google PAIR Guidebook](https://pair.withgoogle.com/guidebook/)

6. **Human-readable transaction context is essential in web3; raw signing data is not enough** — EIP-712 was created specifically so signed messages can be presented in a human-readable format, improving user understanding versus opaque hashes or low-context prompts. The transferable lesson for Solana is to decode and summarize transaction intent in plain language before signature: recipient, asset, amount, approvals/permissions, and downstream effects. [EIP-712](https://eips.ethereum.org/EIPS/eip-712)

7. **Users need a stable mental model for risk: who is involved, what asset moves, what permission is granted, and what could happen next** — Across AI and security UX, good explanations help users answer a small set of repeated questions: What is happening? Why is it risky? What is the impact? What are my safe alternatives? This structure is more effective than surfacing internal technical jargon such as model score, heuristic ID, or protocol metadata by default. [Google PAIR Guidebook](https://pair.withgoogle.com/guidebook/) [Microsoft Human-AI Interaction Guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)

8. **Actionability matters more than exhaustiveness** — In high-stakes UX, the explanation should directly support the next safe action. If a destination wallet is risky, the system should offer concrete alternatives: cancel, send a test amount, verify the address on another channel, require allowlisting, or request a second approver. This follows both finance explainability expectations and human-AI design guidance. [CFPB Circular 2022-03](https://www.consumerfinance.gov/compliance/circulars/consumer-financial-protection-circular-2022-03-adverse-action-notification-requirements-and-artificial-intelligence/) [Microsoft Human-AI Interaction Guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)

## Transferable principles
1. **Lead with the decision, not the data** — Start with a short verdict: Safe, Needs review, Blocked.
2. **Explain in layers** — Layer 1: plain-language reason. Layer 2: consequence. Layer 3: evidence/details on demand.
3. **Tie every explanation to a user action** — Confirm, cancel, reduce size, inspect token, simulate, require extra approval.
4. **Use consistent risk dimensions** — Destination trust, token/protocol risk, permission scope, execution conditions, user policy violations.
5. **Escalate friction by severity** — Inform for low risk, confirm for medium risk, block or require step-up approval for high risk.
6. **Translate technical details into mental-model language** — "This token can freeze transfers" is better than "mint authority still enabled."
7. **Show uncertainty carefully** — If confidence is limited, say what is known and unknown instead of overstating certainty.

## Anti-patterns
1. **Score-only explanations** — "Risk score: 82/100" without reason or implication.
2. **Warning walls** — Large modal text blocks that users learn to dismiss.
3. **Same treatment for every alert** — Causes warning fatigue and trains unsafe override behavior.
4. **Technical-first copy** — Surfacing contract internals, signature payloads, or heuristics before user impact.
5. **No next step** — Telling the user something is risky but not what to do now.
6. **Late explanations** — Revealing critical risk only after the user is mentally committed to signing.
7. **Binary certainty language** — Saying "safe" when the system really means "no known issues detected."

## Concrete recommendations for a Solana guardrails app
1. **Adopt a 4-part explanation template in every risky flow**
   - **Verdict:** "Needs review"
   - **Why:** "Destination wallet has recent suspicious activity and this is your first transfer to it"
   - **Impact:** "Funds may be unrecoverable if sent"
   - **Next step:** "Cancel, verify the address out of band, or send a small test amount"

2. **Design progressive disclosure directly in the transaction review UI**
   - Default card: recipient, token, amount, network fees, verdict.
   - Expandable details: wallet reputation signals, token risk factors, slippage, simulation output, policy triggers.
   - Expert drawer: raw addresses, program IDs, mint authorities, rule IDs, timestamps.

3. **Use a severity ladder for friction**
   - **Low risk:** inline note, no modal.
   - **Medium risk:** confirmation with one-sentence rationale.
   - **High risk:** blocking screen or step-up confirmation with explicit consequence framing.
   - **Critical risk:** deny by policy; explain exactly which rule fired.

4. **Teach the user the same risk vocabulary everywhere**
   Reuse a small set of labels: destination trust, token safety, approval scope, price/execution risk, user policy. Consistency helps users build a working mental model faster.

5. **Prefer plain-language transaction intent over raw blockchain mechanics**
   Examples:
   - "You are giving this app permission to spend up to X token" instead of a raw approval instruction.
   - "This swap may return much less due to high slippage" instead of numeric slippage alone.
   - "This token can still change key properties" instead of only showing mint/freeze authorities.

6. **Add just-in-time educational microcopy, not a separate tutorial dependency**
   Put 1-2 line explanations next to the risky choice, with "Learn more" only when necessary. Tutorials should support, not carry, the safety model.

7. **Support safe fallback actions in-product**
   Add affordances like test transfer, allowlist destination, compare token metadata, inspect simulation, copy verified address, or request second approval. Explanation without a safe alternative will underperform.

8. **Instrument overrides and alert dismissal**
   Track which warnings users ignore, where they hesitate, and which explanations reduce risky confirms. This is the practical defense against warning fatigue over time.

## Sources
- Kept: Nielsen Norman Group — Progressive Disclosure (https://www.nngroup.com/articles/progressive-disclosure/) — established UX guidance for layered information reveal.
- Kept: Apple Human Interface Guidelines — Progressive Disclosure (https://developer.apple.com/design/human-interface-guidelines/progressive-disclosure) — official product-design guidance reinforcing layered disclosure.
- Kept: Sunshine et al. — Crying Wolf: An Empirical Study of SSL Warning Effectiveness (https://www.usenix.org/legacy/events/sec09/tech/full_papers/sunshine.pdf) — foundational evidence on warning fatigue and habituation.
- Kept: CFPB Circular 2022-03 — Adverse action notification requirements and artificial intelligence (https://www.consumerfinance.gov/compliance/circulars/consumer-financial-protection-circular-2022-03-adverse-action-notification-requirements-and-artificial-intelligence/) — strong finance-domain evidence that specific reasons matter.
- Kept: Google PAIR Guidebook (https://pair.withgoogle.com/guidebook/) — practical explainable-AI and human-centered AI design guidance.
- Kept: Microsoft Research — Guidelines for Human-AI Interaction (https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/) — influential framework for timing, expectation-setting, and contextual support.
- Kept: EIP-712: Typed structured data hashing and signing (https://eips.ethereum.org/EIPS/eip-712) — direct web3 evidence for human-readable transaction/signature presentation.
- Dropped: Generic crypto-wallet safety blog posts — excluded because they mostly repeat advice without primary UX evidence.
- Dropped: SEO-style "top fintech UX trends" roundups — excluded because they are trend commentary, not evidence for risky decision flows.

## Gaps
The available evidence is strong on security warnings, explainable AI, and human-readable signing, but weaker on **published Solana-specific UX studies** for transaction safety. A useful next step would be targeted research on Solana wallet review flows, transaction simulation UX, and user behavior around approvals, address validation, and token-risk labeling in Phantom, Backpack, and other wallets.
