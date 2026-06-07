export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const priceMap: Record<string, number> = {
  SOL: 145,
  USDC: 1,
  JUP: 0.85,
  BONK: 0.000022,
  PYTH: 0.32,
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = (url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const prices = Object.fromEntries(symbols.map((symbol) => [symbol, priceMap[symbol] ?? 0]));
  return Response.json({ prices, updated_at: new Date().toISOString() });
}
