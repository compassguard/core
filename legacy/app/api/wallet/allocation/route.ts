export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    total_assets: 3,
    allocation: [
      { symbol: 'SOL', percentage: 86.4, color: '0052ff' },
      { symbol: 'USDC', percentage: 11.9, color: '16a34a' },
      { symbol: 'JUP', percentage: 1.7, color: 'd97706' },
    ],
  });
}
