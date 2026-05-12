import { getEnv, passthrough } from './upstream';

export async function proxyJupiterQuote(searchParams: URLSearchParams) {
  const base = getEnv('JUPITER_API_URL', 'VITE_JUPITER_API_URL') || 'https://lite-api.jup.ag/swap/v1';
  const upstream = new URL(`${base.replace(/\/$/, '')}/quote`);

  for (const [key, value] of searchParams.entries()) {
    upstream.searchParams.set(key, value);
  }

  const response = await fetch(upstream.toString(), {
    // Quotes should stay fresh in serverless environments.
    cache: 'no-store',
  });

  return passthrough(response);
}
