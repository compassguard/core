import { getOrderDetail, triggerOrderExecution } from '@back/services/conditionalOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

type TriggerRequest = {
  trigger_now?: boolean;
};

type RouteContext = {
  params: Promise<{
    orderPda: string;
  }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  void request;
  const { orderPda } = await context.params;
  if (!orderPda || orderPda.length < 32) {
    return Response.json(
      {
        error: {
          code: 'invalid_payload',
          message: 'Missing orderPda path parameter.',
        },
      } satisfies ErrorResponse,
      { status: 400 },
    );
  }

  const snapshot = await getOrderDetail(orderPda);
  if (!snapshot) {
    return Response.json(
      {
        error: {
          code: 'not_found',
          message: 'Conditional order not found.',
        },
      } satisfies ErrorResponse,
      { status: 404 },
    );
  }

  return Response.json(snapshot);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { orderPda } = await context.params;
  if (!orderPda || orderPda.length < 32) {
    return Response.json(
      {
        error: {
          code: 'invalid_payload',
          message: 'Missing orderPda path parameter.',
        },
      } satisfies ErrorResponse,
      { status: 400 },
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as TriggerRequest;
    if (body && body.trigger_now === false) {
      return Response.json({ status: 'trigger_skipped' });
    }

    const txSignature = await triggerOrderExecution(orderPda);
    return Response.json({
      status: 'triggered',
      orderPda,
      tx_signature: txSignature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not trigger order';
    return Response.json(
      {
        error: {
          code: message === 'ORDER_NOT_EXECUTABLE' ? 'order_not_executable' : 'conditional_order_trigger_failed',
          message,
        },
      } satisfies ErrorResponse,
      { status: message === 'ORDER_NOT_EXECUTABLE' || message === 'ORDER_NOT_FOUND' ? 409 : 500 },
    );
  }
}
