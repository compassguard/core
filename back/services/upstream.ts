export function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

export function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

export async function passthrough(upstream: Response) {
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    },
  });
}
