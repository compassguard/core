/**
 * Azure OpenAI Responses API client with streaming support.
 * 
 * This client uses the /openai/responses endpoint (not chat/completions)
 * which is required for certain Azure deployments like gpt-5.3-codex.
 */

import { getEnv } from './upstream';

export type ResponsesToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ResponsesMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ResponsesToolCall = {
  id: string;
  type: 'function_call';
  name: string;
  arguments: string;
};

export type ResponsesOutput = {
  id: string;
  type: 'message' | 'function_call';
  status: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  arguments?: string;
  call_id?: string;
  role?: string;
};

export type ResponsesApiResponse = {
  id: string;
  object: string;
  status: string;
  output: ResponsesOutput[];
  error?: { message: string };
};

export type StreamEvent = {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

/**
 * Converts chat messages to Responses API input format.
 * The Responses API expects a single input string or structured input.
 */
export function messagesToInput(messages: ResponsesMessage[]): string {
  // For simple cases, join messages into a conversation format
  return messages
    .map((m) => {
      if (m.role === 'system') return `[System]: ${m.content}`;
      if (m.role === 'assistant') return `[Assistant]: ${m.content}`;
      return `[User]: ${m.content}`;
    })
    .join('\n\n');
}

/**
 * Converts tool definitions to Responses API format.
 */
export function convertToolsToResponsesFormat(
  tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>
): ResponsesToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  }));
}

/**
 * Calls Azure Responses API with streaming.
 */
export async function callAzureResponsesStream(options: {
  input: string;
  instructions?: string;
  tools?: ResponsesToolDefinition[];
  maxOutputTokens?: number;
}): Promise<ReadableStream<Uint8Array>> {
  const apiKey = getEnv('OPENAI_API_KEY');
  const baseUrl = getEnv('OPENAI_API_URL') || 'https://khora-ai.cognitiveservices.azure.com/openai';
  const model = getEnv('OPENAI_CHAT_MODEL') || 'gpt-5.3-codex';
  const apiVersion = getEnv('AZURE_OPENAI_API_VERSION') || '2025-04-01-preview';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/responses?api-version=${apiVersion}`;

  const body: Record<string, unknown> = {
    model,
    input: options.input,
    max_output_tokens: options.maxOutputTokens || 4096,
    stream: true,
  };

  if (options.instructions) {
    body.instructions = options.instructions;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  return response.body;
}

/**
 * Calls Azure Responses API without streaming (for tool execution flow).
 */
export async function callAzureResponses(options: {
  input: string;
  instructions?: string;
  tools?: ResponsesToolDefinition[];
  maxOutputTokens?: number;
}): Promise<ResponsesApiResponse> {
  const apiKey = getEnv('OPENAI_API_KEY');
  const baseUrl = getEnv('OPENAI_API_URL') || 'https://khora-ai.cognitiveservices.azure.com/openai';
  const model = getEnv('OPENAI_CHAT_MODEL') || 'gpt-5.3-codex';
  const apiVersion = getEnv('AZURE_OPENAI_API_VERSION') || '2025-04-01-preview';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/responses?api-version=${apiVersion}`;

  const body: Record<string, unknown> = {
    model,
    input: options.input,
    max_output_tokens: options.maxOutputTokens || 4096,
    stream: false,
  };

  if (options.instructions) {
    body.instructions = options.instructions;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Parses SSE stream from Azure Responses API.
 */
export async function* parseResponsesStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            return;
          }
          try {
            const event = JSON.parse(data);
            yield event;
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
