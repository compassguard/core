export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ connected: true, network: 'mainnet', latency_ms: 84, tps: 3120 });
}
