import { getUsdcSolQuote, type UsdcSolQuoteResult } from '../../../../back/services/priceQuote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function makeInvalidPayloadResponse(message: string) {
  return Response.json(
    { error: { code: 'invalid_payload', message } },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

function makeProviderErrorResponse(message: string) {
  return Response.json(
    {
      error: {
        code: 'quote_provider_failed',
        message: 'Unable to fetch USDC/SOL quote from provider.',
        details: { reason: message },
      },
    },
    {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

function makeNetworkConfigErrorResponse(message: string) {
  return Response.json(
    {
      error: {
        code: 'invalid_network_config',
        message: 'Invalid devnet quote configuration.',
        details: { reason: message },
      },
    },
    {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const inputToken = url.searchParams.get('input_token')?.trim();
  const outputToken = url.searchParams.get('output_token')?.trim();
  const inputAmountRaw = url.searchParams.get('input_amount');
  const rawSlippage = url.searchParams.get('slippage_bps');
  const rawNetwork = url.searchParams.get('network')?.trim();

  if (!inputToken || !outputToken) {
    return makeInvalidPayloadResponse('Missing input_token and output_token query params.');
  }
  if (!inputAmountRaw) {
    return makeInvalidPayloadResponse('Missing input_amount query param.');
  }

  const inputAmount = Number(inputAmountRaw);
  if (!Number.isFinite(inputAmount)) {
    return makeInvalidPayloadResponse('Invalid input_amount query param.');
  }

  const slippage = rawSlippage?.trim().length ? Number(rawSlippage) : undefined;
  if (rawSlippage && !Number.isFinite(slippage)) {
    return makeInvalidPayloadResponse('Invalid slippage_bps query param.');
  }

  try {
    const quote: UsdcSolQuoteResult = await getUsdcSolQuote({
      network: rawNetwork ?? undefined,
      input_token: inputToken.toUpperCase() as 'USDC' | 'SOL',
      output_token: outputToken.toUpperCase() as 'USDC' | 'SOL',
      input_amount: inputAmount,
      ...(slippage === undefined ? {} : { slippage_bps: slippage }),
    });

    return Response.json(quote, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown quote provider error.';
    const code = (error as { code?: string })?.code;
    console.error('USDC/SOL quote lookup failed:', message);

    if (code === 'invalid_quote_payload' || code === 'invalid_pair' || code === 'invalid_amount') {
      return makeInvalidPayloadResponse(message);
    }
    if (code === 'unsupported_network') {
      return Response.json(
        {
          error: {
            code: 'unsupported_network',
            message: 'Only devnet quotes are supported.',
            details: { reason: message },
          },
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (code === 'invalid_network_config') {
      return makeNetworkConfigErrorResponse(message);
    }
    return makeProviderErrorResponse(message);
  }
}
