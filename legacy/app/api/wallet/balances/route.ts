import { fetchWalletHoldings } from '../../../../back/services/walletHoldings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function makeInvalidPayloadResponse(message: string) {
  return Response.json({ error: { code: 'invalid_payload', message } }, { status: 400 });
}

function makeProviderErrorResponse(message: string, status = 502) {
  return Response.json(
    {
      error: {
        code: 'wallet_balance_fetch_failed',
        message: 'Unable to fetch wallet balances from Solana RPC.',
        details: { reason: message },
      },
    },
    { status },
  );
}

function makeNetworkConfigErrorResponse(message: string) {
  return Response.json(
    {
      error: {
        code: 'invalid_network_config',
        message: 'Invalid devnet wallet balance configuration.',
        details: { reason: message },
      },
    },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address')?.trim();
  const network = url.searchParams.get('network')?.trim();

  if (!address) {
    return makeInvalidPayloadResponse('Missing address query param.');
  }

  try {
    const holdings = await fetchWalletHoldings({ address, network: network ?? undefined });
    return Response.json(holdings);
  } catch (error) {
    const walletError = error as { code?: string };
    const message = error instanceof Error ? error.message : 'Unknown error while fetching balances.';
    console.error('Wallet balance lookup failed:', message);

    if (walletError?.code === 'invalid_address') {
      return makeInvalidPayloadResponse(message);
    }
    if (walletError?.code === 'unsupported_network') {
      return Response.json(
        {
          error: {
            code: 'unsupported_network',
            message: 'Only devnet balances are supported.',
            details: { reason: message },
          },
        },
        { status: 400 },
      );
    }
    if (walletError?.code === 'invalid_mint_config' || walletError?.code === 'invalid_network_config') {
      return makeNetworkConfigErrorResponse(message);
    }
    return makeProviderErrorResponse(message);
  }
}
