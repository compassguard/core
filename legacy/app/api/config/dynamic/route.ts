export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DynamicConfigResponse = {
  environment_id?: string;
};

function getDynamicEnvironmentId(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID?.trim() ||
    process.env.DYNAMIC_ENVIRONMENT_ID?.trim() ||
    undefined
  );
}

export async function GET() {
  const body: DynamicConfigResponse = {};
  const environmentId = getDynamicEnvironmentId();

  if (environmentId) {
    body.environment_id = environmentId;
  }

  return Response.json(body, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
