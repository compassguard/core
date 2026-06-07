import { buildAppSessionClearCookie } from '@back/services/auth/appSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return Response.json(
    { ok: true },
    {
      status: 200,
      headers: {
        'Set-Cookie': buildAppSessionClearCookie(),
      },
    },
  );
}
