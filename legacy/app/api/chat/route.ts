import { proxyAgenticChat } from '@back/services/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'Invalid JSON payload' } },
      { status: 400 }
    );
  }

  return proxyAgenticChat(body, { request });
}
