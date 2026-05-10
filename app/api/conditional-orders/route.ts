import {
  getOrdersForUser,
  pollConditionalOrdersThrottled,
} from '@back/services/conditionalOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export async function GET(request: Request): Promise<Response> {
  try {
    const user = new URL(request.url).searchParams.get('user');
    if (!user) {
      return Response.json(
        { error: { code: 'invalid_payload', message: 'Missing query param user.' } } satisfies ErrorResponse,
        { status: 400 },
      );
    }

    const orders = await getOrdersForUser(user);
    return Response.json(orders);
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'conditional_orders_fetch_failed',
          message: error instanceof Error ? error.message : 'Unable to fetch conditional orders',
        },
      } satisfies ErrorResponse,
      { status: 500 },
    );
  }
}

export async function POST(): Promise<Response> {
  try {
    await pollConditionalOrdersThrottled(true);
    return Response.json({ status: 'index_refreshed' });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'conditional_orders_refresh_failed',
          message: error instanceof Error ? error.message : 'Unable to refresh conditional orders',
        },
      } satisfies ErrorResponse,
      { status: 500 },
    );
  }
}
