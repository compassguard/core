---
name: Converge Web3 Agentic Wallet
colors:
  # Base & Backgrounds
  background: '#f8fafc' # Light grayish blue for the main app background
  surface: '#ffffff' # Pure white for cards, sidebars, and chat containers
  surface-hover: '#f1f5f9'
  
  # Borders & Lines
  outline: '#e2e8f0' # Subtle borders for cards and sidebars
  outline-variant: '#cbd5e1'
  
  # Text
  on-surface: '#0f172a' # High contrast dark slate for primary text
  on-surface-variant: '#64748b' # Muted slate for secondary text/labels
  
  # Primary Brand (The Trust Blue)
  primary: '#0052ff' # Vibrant Coinbase/Stripe blue for user bubbles and primary actions
  primary-hover: '#0043d1'
  on-primary: '#ffffff' # Text on primary buttons
  
  # Agent Specific
  agent-bubble: '#f1f5f9' # Soft gray for the AI's responses
  on-agent-bubble: '#0f172a'
  
  # Status & Semantic (Rich Cards)
  error-bg: '#fef2f2'
  error-border: '#fca5a5'
  error-text: '#dc2626' # Used for "High Risk" and "Price Impact Alert"
  warning-bg: '#fffbeb'
  warning-border: '#fcd34d'
  warning-text: '#d97706' # Used for "High Network Congestion"
  success-bg: '#f0fdf4'
  success-text: '#16a34a' # Used for positive metrics (+2.4%)

typography:
  fontFamily: 'Inter, sans-serif'
  display-lg:
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
  headline-lg:
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontSize: 16px
    fontWeight: '500'
    lineHeight: '1.5'
  body-md: # Standard chat text
    fontSize: 15px 
    fontWeight: '400'
    lineHeight: '1.5'
  label-sm: # Metadata, timestamps, small tags
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1.4'

rounded:
  sm: 0.375rem # 6px - Small badges
  DEFAULT: 0.5rem # 8px - Inner elements
  md: 0.75rem # 12px - Buttons
  lg: 1rem # 16px - Rich UI Cards (Swap Proposals)
  xl: 1.5rem # 24px - Chat bubbles and large containers
  full: 9999px # Avatars and pills

spacing:
  xs: 4px
  sm: 8px
  md: 16px # Standard padding for mobile
  lg: 24px # Standard padding for cards
  xl: 32px
  container-max: 1440px # Max width for desktop web dashboard
---

## Brand & Style

This design system defines an "Agent-First" Web3 wallet built as a responsive web application. The aesthetic is **Web2 Trust**: it borrows the structural precision of Stripe and the high-fidelity minimalism of modern fintechs to eliminate "crypto-anxiety". 

**Core Directives for Generative UI:**
1. **Not a Native App, but Mobile-Optimized:** This is a web application. On mobile (`< 768px`), it acts as a full-screen chat interface with a sticky header. On desktop (`>= 1024px`), it expands into a powerful 3-column dashboard, keeping the chat active in the center.
2. **High-Fidelity Minimalism:** Avoid aggressive gradients, neon colors, or cyberpunk aesthetics. Rely on generous whitespace, pure white cards (`#ffffff`) against a subtle gray background (`#f8fafc`), and hairline borders (`#e2e8f0`).

## Layout Architecture (Web Responsive)

- **Mobile View (Default):** - Sticky Top Header: Shows Total Balance and quick scrollable asset pills (e.g., ETH, SOL).
  - Main Body: The conversational feed.
  - Sticky Bottom Bar: Text input with a prominent send button.
- **Desktop View (md/lg breakpoints):**
  - **Left Sidebar (280px):** User profile, Chat History list, and Quick Actions navigation.
  - **Center Column (Flexible, max 800px):** The main chat feed and bottom input area.
  - **Right Sidebar (320px):** Persistent Wallet Overview (Total Balance, Asset Allocation Donut Chart, Network Latency).

## Component Specifications

### 1. Chat Bubbles
- **User Bubble:** Aligned right. Background `primary` (#0052ff), text `on-primary` (#ffffff). Border radius `xl` (24px) with the bottom-right corner slightly less rounded (e.g., 4px) to indicate direction.
- **Agent Bubble:** Aligned left. Background `agent-bubble` (#f1f5f9), text `on-agent-bubble` (#0f172a). Border radius `xl` (24px) with the bottom-left corner less rounded.

### 2. Rich UI Cards (Agent Actions)
When the agent proposes a transaction, it MUST render a Rich UI Card within the chat feed, not a modal.
- **Container:** Background `surface`, Border `1px solid outline`, Radius `lg` (16px). Shadow should be extremely subtle (`shadow-sm` in Tailwind).
- **Internal Layout:** Use generous padding (`p-6` or 24px). Separate logical sections (e.g., the swap amounts vs. the network fee) with subtle horizontal dividers.
- **Action Buttons:** Placed at the bottom of the card. The "Confirm" button must be `primary` blue, highly visible, and full-width on mobile.

### 3. Alert & Warning States
Trust is built on proactive security.
- **High Risk (Price Impact/Malicious Contract):** Render a card with an `error-border` and a subtle `error-bg` header. Include a prominent red warning icon.
- **Warning (Network Congestion):** Render a card with a `warning-border` and a yellow/orange icon to inform the user without blocking the action.

### 4. Typography & Data Display
- **Balances:** Use `display-lg` for the main portfolio balance to create a clear focal point.
- **Tokens:** Always pair token tickers (ETH, SOL, USDC) with their respective clean icons in small circular containers.
