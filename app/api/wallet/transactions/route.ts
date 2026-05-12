import {
  normalizeTransactionLimit,
  validateBeforeCursor,
  validateWalletAddress,
  fetchWalletTransactions,
} from '../../../../back/services/transactionHistory';
// NOTE: keep relative import to avoid path alias gaps in vitest transforms.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_LIMIT_DEFAULT = 20;

function makeInvalidPayloadResponse(message: string) {
  return Response.json({ error: { code: 'invalid_payload', message } }, { status: 400 });
}

function makeProviderErrorResponse() {
  return Response.json(
    {
      error: {
        code: 'provider_error',
        message: 'Unable to fetch public transaction history from the Solana provider.',
        details: { reason: 'provider_request_failed' },
      },
    },
    { status: 502 },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawAddress = url.searchParams.get('address');
  if (!rawAddress || !rawAddress.trim()) {
    return makeInvalidPayloadResponse('Missing address query param.');
  }

  const rawLimit = url.searchParams.get('limit');
  const rawBefore = url.searchParams.get('before');

  let limit = SIGNATURE_LIMIT_DEFAULT;
  if (rawLimit !== null) {
    const trimmed = rawLimit.trim();
    if (!trimmed) {
      return makeInvalidPayloadResponse('Invalid limit query param.');
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return makeInvalidPayloadResponse('Invalid limit query param.');
    }
    limit = normalizeTransactionLimit(parsed);
  }

  let before: string | undefined;
  try {
    before = validateBeforeCursor(rawBefore);
  } catch {
    return makeInvalidPayloadResponse('Invalid before query param.');
  }

  let address: string;
  try {
    address = validateWalletAddress(rawAddress);
  } catch {
    return makeInvalidPayloadResponse('Invalid address query param.');
  }

  try {
    return Response.json(await fetchWalletTransactions(address, limit, before));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider lookup failed.';
    console.error('Wallet transaction lookup failed:', message);
    return makeProviderErrorResponse();
  }
}
