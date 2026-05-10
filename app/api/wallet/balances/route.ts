export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const RPC_TIMEOUT_MS = 10_000;

type RpcResponse = {
  jsonrpc?: unknown;
  result?: { value?: unknown };
  error?: { message?: unknown };
};

type RpcGetBalanceResponse = RpcResponse & {
  result: { value: number };
};

function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL?.trim() || SOLANA_DEVNET_RPC_URL;
}

async function getSolBalanceLamports(address: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const rpcResponse = await fetch(getSolanaRpcUrl(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
    });

    if (!rpcResponse.ok) {
      throw new Error(`SOLANA RPC request failed with status ${rpcResponse.status}`);
    }

    const parsed = (await rpcResponse.json()) as RpcResponse;

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid SOLANA RPC response shape.');
    }

    if ('error' in parsed) {
      const rpcMessage = typeof parsed.error?.message === 'string' ? parsed.error.message : 'Unknown SOLANA RPC error.';
      throw new Error(rpcMessage);
    }

    const balance = (parsed as RpcGetBalanceResponse).result?.value;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      throw new Error('Invalid SOL balance value from RPC.');
    }

    return balance;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address')?.trim();
  if (!address) {
    return Response.json({ error: { code: 'invalid_payload', message: 'Missing address query param.' } }, { status: 400 });
  }

  try {
    const solLamports = await getSolBalanceLamports(address);
    const solUiAmount = solLamports / 10 ** SOL_DECIMALS;

    const balances = [
      {
        symbol: 'SOL',
        mint: SOL_MINT,
        amount: String(solLamports),
        decimals: SOL_DECIMALS,
        ui_amount: solUiAmount,
        usd_value: 0,
      },
    ];

    return Response.json({
      balances,
      total_usd: 0,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error while fetching balances.';
    console.error('Wallet balance lookup failed:', message);
    return Response.json(
      {
        error: {
          code: 'wallet_balance_fetch_failed',
          message: 'Unable to fetch wallet balances from Solana RPC.',
          details: { reason: message },
        },
      },
      { status: 502 },
    );
  }
}
