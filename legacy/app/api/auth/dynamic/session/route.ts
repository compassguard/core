import {
  buildAppSessionSetCookie,
  createDynamicAppSession,
  type AppWalletType,
} from '@back/services/auth/appSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CreateDynamicSessionRequest = {
  dynamicUserId?: string;
  walletAddress?: string;
  walletType?: AppWalletType;
  walletProvider?: string;
  dynamicAuthToken?: string;
};

export async function POST(request: Request) {
  let body: CreateDynamicSessionRequest;

  try {
    body = (await request.json()) as CreateDynamicSessionRequest;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'Invalid JSON payload' } },
      { status: 400 },
    );
  }

  if (!body.walletAddress || !body.walletType) {
    return Response.json(
      { error: { code: 'invalid_payload', message: 'walletAddress and walletType are required' } },
      { status: 400 },
    );
  }

  try {
    const session = await createDynamicAppSession({
      dynamicUserId: body.dynamicUserId,
      walletAddress: body.walletAddress,
      walletType: body.walletType,
      walletProvider: body.walletProvider,
      dynamicAuthToken: body.dynamicAuthToken,
    });

    return Response.json(
      {
        session_id: session.identity.sessionId,
        dynamic_user_id: session.identity.dynamicUserId,
        wallet_address: session.identity.walletAddress,
        wallet_type: session.identity.walletType,
        wallet_provider: session.identity.walletProvider,
        verified_at: session.identity.verifiedAt,
        expires_at: new Date(session.claims.expiresAt).toISOString(),
        verification_mode: session.identity.verificationMode,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': buildAppSessionSetCookie(session.token),
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'dynamic_auth_failed',
          message: error instanceof Error ? error.message : 'Dynamic authentication failed',
        },
      },
      { status: 401 },
    );
  }
}
