import { getEnv, jsonResponse, passthrough } from './upstream';

export async function proxyBirdeyeTokenSecurity(mint: string | null) {
  const apiKey = getEnv('BIRDEYE_API_KEY', 'VITE_BIRDEYE_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'BIRDEYE_API_KEY_NOT_CONFIGURED' }, { status: 503 });
  }

  if (!mint) {
    return jsonResponse({ error: 'MISSING_MINT' }, { status: 400 });
  }

  const base = getEnv('BIRDEYE_API_URL', 'VITE_BIRDEYE_API_URL') || 'https://public-api.birdeye.so';
  const response = await fetch(`${base.replace(/\/$/, '')}/defi/token_security?address=${encodeURIComponent(mint)}`, {
    headers: {
      accept: 'application/json',
      'x-chain': 'solana',
      'X-API-KEY': apiKey,
    },
    cache: 'no-store',
  });

  return passthrough(response);
}
