import { proxyRiskScore } from '@back/services/riskScore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyRiskScore(url.searchParams.get('mint'));
}
