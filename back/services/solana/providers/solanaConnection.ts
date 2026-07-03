/**
 * Centralized Solana Connection with rate limiting and caching
 * 
 * This module provides a shared connection instance to avoid creating
 * multiple connections and to implement request throttling.
 */

import { Connection, ConnectionConfig } from '@solana/web3.js';

import { debug } from '@back/guardrail/debugLogger';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Connection configuration with built-in rate limiting
const CONNECTION_CONFIG: ConnectionConfig = {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
  disableRetryOnRateLimit: false, // Let the connection handle retries
};

// Singleton connection instance
let sharedConnection: Connection | null = null;

// Request tracking for manual throttling
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 100; // Minimum 100ms between requests

/**
 * Get the shared Solana connection instance.
 * Creates a new connection if one doesn't exist.
 */
export function getConnection(): Connection {
  if (!sharedConnection) {
    debug("connection", "createConnection", "Creating shared connection", { url: RPC_URL });
    sharedConnection = new Connection(RPC_URL, CONNECTION_CONFIG);
  }
  return sharedConnection;
}

/**
 * Get the RPC URL being used
 */
export function getRpcUrl(): string {
  return RPC_URL;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Throttle requests to avoid rate limiting.
 * Call this before making RPC requests.
 */
export async function throttleRequest(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    await sleep(waitTime);
  }
  
  lastRequestTime = Date.now();
}

/**
 * Execute a function with automatic throttling.
 */
export async function withThrottle<T>(fn: () => Promise<T>): Promise<T> {
  await throttleRequest();
  return fn();
}

/**
 * Simple in-memory cache for RPC responses
 */
const cache = new Map<string, { data: unknown; expiresAt: number }>();

/**
 * Get cached data or fetch fresh data
 */
export async function getCachedOrFetch<T>(
  cacheKey: string,
  fetchFn: () => Promise<T>,
  ttlMs: number = 5000 // Default 5 second TTL
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(cacheKey);
  
  if (cached && cached.expiresAt > now) {
    return cached.data as T;
  }
  
  await throttleRequest();
  const data = await fetchFn();
  
  cache.set(cacheKey, {
    data,
    expiresAt: now + ttlMs,
  });
  
  return data;
}

/**
 * Clear all cached data
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Clear expired cache entries
 */
export function pruneCache(): void {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

// Prune cache every 30 seconds
if (typeof setInterval !== 'undefined') {
  setInterval(pruneCache, 30000);
}
