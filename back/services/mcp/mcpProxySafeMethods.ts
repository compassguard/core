/**
 * Safe non-tool MCP method classification for Wave 11 proxy.
 *
 * Only methods explicitly listed here are forwarded without tools/call
 * interception. All other methods (including unknown methods) fail closed.
 *
 * tools/call is explicitly EXCLUDED from safe forwarding — it must always
 * go through the policy interceptor before any downstream forwarding.
 */

export { PROXY_SAFE_METHODS, isSafeNonToolMethod } from "./mcpProxyContracts";