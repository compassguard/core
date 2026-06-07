import { proxyBirdeyeTokenSecurity } from '@back/services/birdeye';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyBirdeyeTokenSecurity(url.searchParams.get('mint'));
}
