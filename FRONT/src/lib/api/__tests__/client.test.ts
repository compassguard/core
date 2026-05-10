import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from '../client';

function sseResponseFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
}

describe('streamChat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses SSE events split across network chunks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponseFromChunks([
        'event: session\n',
        'data: {"session_id":"session-1"}\n\n',
        'event: token\ndata: {"content":"Hola"}\n\n',
        'event: done\n',
        'data: {"session_id":"session-1"}\n\n',
      ])
    );

    const events: string[] = [];

    await streamChat(
      {
        type: 'user_message',
        content: 'Hola',
      },
      {
        onSession: (sessionId) => events.push(`session:${sessionId}`),
        onToken: (content) => events.push(`token:${content}`),
        onDone: (data) => events.push(`done:${data.session_id}`),
      }
    );

    expect(events).toEqual(['session:session-1', 'token:Hola', 'done:session-1']);
  });
});
