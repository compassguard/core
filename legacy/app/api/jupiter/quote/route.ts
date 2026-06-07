import { proxyJupiterQuote } from '@back/services/jupiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyJupiterQuote(url.searchParams);
}
