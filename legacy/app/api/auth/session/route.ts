import { getAppSessionFromRequest } from '@back/services/auth/appSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const identity = getAppSessionFromRequest(request);

  if (!identity) {
    return Response.json(
      { error: { code: 'session_not_found', message: 'App session not found or expired' } },
      { status: 401 },
    );
  }

  return Response.json(
    {
      session_id: identity.sessionId,
      dynamic_user_id: identity.dynamicUserId,
      wallet_address: identity.walletAddress,
      wallet_type: identity.walletType,
      wallet_provider: identity.walletProvider,
      verified_at: identity.verifiedAt,
      verification_mode: identity.verificationMode,
    },
    { status: 200 },
  );
}
