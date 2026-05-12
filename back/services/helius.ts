import { getEnv, jsonResponse, passthrough } from './upstream';

export async function proxyHeliusTransactions(body: unknown) {
  const apiKey = getEnv('HELIUS_API_KEY', 'VITE_HELIUS_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'HELIUS_API_KEY_NOT_CONFIGURED' }, { status: 503 });
  }

  if (!body || typeof body !== 'object' || !Array.isArray((body as { transactions?: unknown }).transactions)) {
    return jsonResponse({ error: 'MISSING_TRANSACTIONS' }, { status: 400 });
  }

  const transactions = (body as { transactions: string[] }).transactions;
  const base = getEnv('HELIUS_API_URL', 'VITE_HELIUS_API_URL') || 'https://api.helius.xyz';
  const response = await fetch(`${base.replace(/\/$/, '')}/v0/transactions/?api-key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions }),
    cache: 'no-store',
  });

  return passthrough(response);
}
