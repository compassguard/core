/**
 * Backend Chat Service - Unified Contract
 * 
 * Implements:
 * - SSE streaming for user_message (LLM responses)
 * - JSON responses for function_approve/function_reject
 * - Tool: transfer (unified params)
 */

import { getEnv, jsonResponse } from './upstream';
import {
  getSession,
  createSession,
  updateSession,
  clearPendingProposal,
} from './chatSessionStore';
import {
  prepareTransferResult,
  generateTransferDisplay,
  assessTransferRisk,
  type TransferParams,
} from './tools/transfer';
import {
  simulateBuySolQuote,
  evaluateConditionalBuy,
  type ConditionalBuySolParams,
} from './tools/conditionalBuySol';
import { verifyOracleExecutionTx } from './onchainApproval';
import {
  callAzureResponsesStream,
  callAzureResponses,
  parseResponsesStream,
  type ResponsesToolDefinition,
} from './azureResponsesClient';
import { web3 } from '@coral-xyz/anchor';

// ============================================================================
// Types - Unified Contract
// ============================================================================

type ChatRequest =
  | {
      type: 'user_message';
      content: string;
      session_id?: string;
      user_address?: string;
      user_threshold_usd?: number;
    }
  | {
      type: 'function_approve';
      session_id: string;
      execute_tx_signature?: string;
    }
  | {
      type: 'function_reject';
      session_id: string;
      reason?: string;
    };

type AgentTextMessage = {
  type: 'text';
  content: string;
  execute?: {
    status: 'success' | 'failed';
    tx_hash?: string;
    error?: string;
  };
  timestamp: string;
};

type AgentFunctionCallMessage = {
  type: 'function_call';
  function: {
    name: 'transfer' | 'conditional_buy_sol';
    params: TransferParams | ConditionalBuySolParams;
  };
  display: {
    summary: string;
    fee_usd?: number;
    provider?: string;
  };
  risk: {
    score: number;
    level: 'low' | 'medium' | 'critical';
    reasons?: string[];
  };
  timestamp: string;
};

type AgentAlertMessage = {
  type: 'alert';
  severity: 'info' | 'warning' | 'danger';
  content: string;
  timestamp: string;
};

type AgentMessage = AgentTextMessage | AgentFunctionCallMessage | AgentAlertMessage;

// ============================================================================
// Tool Definition for Azure Responses API
// ============================================================================

const TRANSFER_TOOL: ResponsesToolDefinition = {
  type: 'function',
  name: 'transfer',
  description:
    'Prepara una transferencia de SOL o tokens a otra wallet de Solana. ' +
    'NO ejecuta la transferencia on-chain. Retorna una acción preparada que requiere aprobación del usuario. ' +
    'Usa esta herramienta cuando el usuario quiera enviar/transferir SOL o tokens a otra dirección.',
  parameters: {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        description: 'Cantidad a transferir (debe ser positiva)',
      },
      token: {
        type: 'string',
        description: 'Símbolo del token (default: SOL)',
      },
      recipient: {
        type: 'string',
        description: 'Dirección de destino (Solana public key)',
      },
      memo: {
        type: 'string',
        description: 'Memo opcional para la transacción',
      },
    },
    required: ['amount', 'recipient'],
  },
};

const CONDITIONAL_BUY_SOL_TOOL: ResponsesToolDefinition = {
  type: 'function',
  name: 'conditional_buy_sol',
  description:
    'Prepara una compra condicional de SOL con USDC. ' +
    'Debe usarse cuando el usuario diga comprar SOL solo si el precio está por debajo de X USD. ' +
    'No ejecuta swap real; prepara una aprobación condicionada a validación on-chain de oracle.',
  parameters: {
    type: 'object',
    properties: {
      input_token: {
        type: 'string',
        description: 'Token de entrada (MVP: USDC)',
        enum: ['USDC'],
      },
      input_amount: {
        type: 'number',
        description: 'Cantidad de USDC a usar para comprar SOL',
      },
      target_price_usd: {
        type: 'number',
        description: 'Ejecutar solo si SOL/USD es menor o igual a este precio',
      },
      min_sol_out: {
        type: 'number',
        description: 'Cantidad mínima de SOL esperada (opcional)',
      },
    },
    required: ['input_token', 'input_amount', 'target_price_usd'],
  },
};

const ALL_TOOLS = [TRANSFER_TOOL, CONDITIONAL_BUY_SOL_TOOL];

// ============================================================================
// Helpers
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

function generateSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
} {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      streamController.enqueue(chunk);
    },
    close() {
      streamController.close();
    },
    abort(err) {
      streamController.error(err);
    },
  });

  const writer = writable.getWriter();

  return { stream, writer, encoder };
}

async function writeSSE(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown
) {
  await writer.write(encoder.encode(sseEvent(event, data)));
}

function getSolanaConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new web3.Connection(rpcUrl, 'confirmed');
}

async function buildUnsignedSolTransferTx(params: {
  fromWallet: string;
  toWallet: string;
  amountSol: number;
}): Promise<{ txBase64: string; blockhash: string; lastValidBlockHeight: number }> {
  const connection = getSolanaConnection();
  const from = new web3.PublicKey(params.fromWallet);
  const to = new web3.PublicKey(params.toWallet);
  const lamports = Math.round(params.amountSol * web3.LAMPORTS_PER_SOL);

  const ix = web3.SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: to,
    lamports,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const msg = new web3.TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new web3.VersionedTransaction(msg);
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');

  return { txBase64, blockhash, lastValidBlockHeight };
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function proxyAgenticChat(body: unknown): Promise<Response> {
  const apiKey = getEnv('OPENAI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: { code: 'config_error', message: 'OPENAI_API_KEY not configured' } }, { status: 503 });
  }

  const request = body as ChatRequest;

  if (!request || typeof request !== 'object' || !('type' in request)) {
    return jsonResponse({ error: { code: 'invalid_payload', message: 'Missing request type' } }, { status: 400 });
  }

  // Route based on request type
  switch (request.type) {
    case 'user_message':
      return handleUserMessage(request);
    case 'function_approve':
      return handleFunctionApprove(request);
    case 'function_reject':
      return handleFunctionReject(request);
    default:
      return jsonResponse({ error: { code: 'invalid_type', message: 'Unknown request type' } }, { status: 400 });
  }
}

// ============================================================================
// User Message Handler (SSE)
// ============================================================================

async function handleUserMessage(request: {
  type: 'user_message';
  content: string;
  session_id?: string;
  user_address?: string;
  user_threshold_usd?: number;
}): Promise<Response> {
  if (!request.content?.trim()) {
    return jsonResponse({ error: { code: 'invalid_payload', message: 'Content is required' } }, { status: 400 });
  }

  const { stream, writer, encoder } = createSSEStream();

  (async () => {
    try {
      // Get or create session
      let sessionId = request.session_id?.trim();
      let session = sessionId ? getSession(sessionId) : null;

      if (!session) {
        sessionId = sessionId || generateSessionId();
        session = createSession(sessionId, sessionId, request.user_address);
        console.log(`[chat] New session: ${sessionId}`);
      } else if (request.user_address && !session.userAddress) {
        // Update user address if provided and not set
        updateSession(sessionId, { userAddress: request.user_address });
        session.userAddress = request.user_address;
      }

      // Send session info first
      await writeSSE(writer, encoder, 'session', { session_id: sessionId });

      console.log(`[chat] User message: ${sessionId} - ${request.content.slice(0, 50)}...`);

      // Build conversation
      const systemInstruction =
        'Eres un asistente de wallet para Solana llamado Wallet Copilot. ' +
        'Ayudas a los usuarios a realizar transferencias y compras condicionales de SOL de forma segura. ' +
        'Cuando el usuario pida transferir SOL o tokens, usa la herramienta transfer. ' +
        'Cuando el usuario pida comprar SOL solo si el precio está por debajo de X, usa la herramienta conditional_buy_sol. ' +
        'IMPORTANTE: NUNCA digas que ejecutaste una transferencia on-chain. Solo puedes preparar la acción y pedir aprobación del usuario. ' +
        'Responde en español de forma concisa y amigable.';

      const conversationInput = `[Usuario]: ${request.content}`;

      // First call: check if model wants to use tools
      const initialResponse = await callAzureResponses({
        input: conversationInput,
        instructions: systemInstruction,
        tools: ALL_TOOLS,
        maxOutputTokens: 4096,
      });

      // Check for tool calls in output
      const toolCall = initialResponse.output?.find(
        (o) => o.type === 'function_call' && (o.name === 'transfer' || o.name === 'conditional_buy_sol')
      );

      if (toolCall && toolCall.name) {
        if (toolCall.name === 'transfer') {
          await handleTransferToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            session.userAddress,
            writer,
            encoder,
            conversationInput,
            systemInstruction
          );
        } else {
          await handleConditionalBuyToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            writer,
            encoder
          );
        }
        return;
      }

      // No tool call - stream the response directly
      const responseStream = await callAzureResponsesStream({
        input: conversationInput,
        instructions: systemInstruction,
        tools: ALL_TOOLS,
        maxOutputTokens: 4096,
      });

      await streamResponseToSSE(responseStream, writer, encoder);
      await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    } catch (err) {
      console.error('[chat] Stream error:', err);
      await writeSSE(writer, encoder, 'error', {
        code: 'stream_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed
      }
    }
  })();

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

async function handleConditionalBuyToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  let toolArgs: ConditionalBuySolParams;
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    toolArgs = {
      input_token: 'USDC',
      input_amount: parsed.input_amount,
      target_price_usd: parsed.target_price_usd,
      min_sol_out: parsed.min_sol_out,
    };
  } catch {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Could not parse conditional_buy_sol tool arguments',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  const quote = simulateBuySolQuote(toolArgs);
  const decision = evaluateConditionalBuy(toolArgs, quote);

  if (decision.decision === 'WAIT_CONDITION_NOT_MET') {
    await writeSSE(writer, encoder, 'token', {
      content: `Tu condición de compra aún no se cumple. Precio SOL actual simulado: ${quote.sol_usd_price} USD, target: ${toolArgs.target_price_usd} USD.`,
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  if (decision.decision === 'REJECT') {
    await writeSSE(writer, encoder, 'error', {
      code: 'conditional_buy_rejected',
      message: decision.reasons.join(', '),
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  const oracleFeed = process.env.PYTH_SOL_USD_FEED || 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

  const proposal: AgentFunctionCallMessage = {
    type: 'function_call',
    function: {
      name: 'conditional_buy_sol',
      params: toolArgs,
    },
    display: {
      summary: `Comprar SOL con ${toolArgs.input_amount} USDC si SOL <= ${toolArgs.target_price_usd} USD`,
      fee_usd: 0.01,
      provider: 'simulated_devnet_market',
    },
    risk: {
      score: 35,
      level: 'medium',
      reasons: [
        'Compra condicional requiere validación oracle on-chain',
        ...decision.reasons,
      ],
    },
    timestamp: now(),
  };

  updateSession(sessionId, {
    pendingProposal: {
      toolName: 'conditional_buy_sol',
      toolArgs: {
        ...toolArgs,
        oracle_feed_pubkey: oracleFeed,
        simulated_quote: quote,
      },
      toolResult: {
        status: 'prepared',
        reason: 'READY_FOR_ONCHAIN_ORACLE_APPROVAL',
      },
      createdAt: Date.now(),
    },
  });

  await writeSSE(writer, encoder, 'proposal', proposal);
  await writeSSE(writer, encoder, 'done', {
    session_id: sessionId,
    awaiting_approval: true,
    action_type: 'BUY_SOL_ORACLE_CONDITIONAL',
    oracle_feed_pubkey: oracleFeed,
  });
  await writer.close();
}

async function handleTransferToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  userAddress: string | null,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  conversationInput: string,
  systemInstruction: string
) {
  // Parse tool arguments
  let toolArgs: TransferParams;
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    toolArgs = {
      amount: parsed.amount,
      token: parsed.token || 'SOL',
      recipient: parsed.recipient,
      memo: parsed.memo,
    };
  } catch {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Could not parse tool arguments',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  // Check if we have user address
  if (!userAddress) {
    await writeSSE(writer, encoder, 'error', {
      code: 'no_wallet',
      message: 'No wallet connected. Please connect your wallet first.',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  // Execute tool
  const toolResult = prepareTransferResult(toolArgs, userAddress);

  if (toolResult.status === 'prepared') {
    // Generate display and risk info
    const display = generateTransferDisplay(toolArgs);
    const risk = assessTransferRisk(toolArgs);

    // Store pending proposal for HITL
    updateSession(sessionId, {
      pendingProposal: {
        toolName: 'transfer',
        toolArgs,
        toolResult,
        createdAt: Date.now(),
      },
    });

    console.log(`[chat] Proposal created: ${sessionId} - transfer ${toolArgs.amount} ${toolArgs.token}`);

    // Build proposal message
    const proposal: AgentFunctionCallMessage = {
      type: 'function_call',
      function: {
        name: 'transfer',
        params: toolArgs,
      },
      display,
      risk,
      timestamp: now(),
    };

    // Send proposal event
    await writeSSE(writer, encoder, 'proposal', proposal);
    await writeSSE(writer, encoder, 'done', { session_id: sessionId, awaiting_approval: true });
    await writer.close();
    return;
  } else {
    // Tool denied the action, stream explanation
    const denialInput =
      conversationInput +
      `\n\n[Resultado de herramienta transfer]: La transferencia fue rechazada. Razón: ${toolResult.reason}`;

    const denialStream = await callAzureResponsesStream({
      input: denialInput,
      instructions: systemInstruction,
      maxOutputTokens: 1024,
    });

    await streamResponseToSSE(denialStream, writer, encoder);
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }
}

async function streamResponseToSSE(
  responseStream: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  for await (const event of parseResponsesStream(responseStream)) {
    if (event.type === 'response.output_text.delta') {
      const delta = event.delta || '';
      if (delta) {
        await writeSSE(writer, encoder, 'token', { content: delta });
      }
    } else if (event.type === 'response.content_part.delta') {
      const delta = event.delta?.text || '';
      if (delta) {
        await writeSSE(writer, encoder, 'token', { content: delta });
      }
    } else if (event.type === 'response.output_item.added') {
      if (event.item?.type === 'message' && event.item?.content) {
        for (const part of event.item.content) {
          if (part.text) {
            await writeSSE(writer, encoder, 'token', { content: part.text });
          }
        }
      }
    } else if (event.type === 'response.completed') {
      const output = event.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === 'message' && item.content) {
            for (const part of item.content) {
              if (part.text && part.type === 'output_text') {
                await writeSSE(writer, encoder, 'token', { content: part.text });
              }
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// Function Approve Handler (JSON)
// ============================================================================

async function handleFunctionApprove(request: {
  type: 'function_approve';
  session_id: string;
  execute_tx_signature?: string;
}): Promise<Response> {
  if (!request.session_id?.trim()) {
    return jsonResponse({ error: { code: 'invalid_payload', message: 'session_id is required' } }, { status: 400 });
  }

  const session = getSession(request.session_id);
  if (!session) {
    return jsonResponse({ error: { code: 'session_not_found', message: 'Session not found or expired' } }, { status: 404 });
  }

  if (!session.pendingProposal) {
    return jsonResponse({ error: { code: 'no_pending_proposal', message: 'No pending proposal for this session' } }, { status: 400 });
  }

  const { toolArgs, toolName } = session.pendingProposal;
  clearPendingProposal(request.session_id);

  console.log(`[chat] Proposal approved: ${request.session_id}`);

  if (toolName === 'conditional_buy_sol') {
    if (!request.execute_tx_signature) {
      return jsonResponse(
        {
          error: {
            code: 'missing_onchain_proof',
            message: 'execute_tx_signature is required for oracle-gated conditional buy',
          },
        },
        { status: 400 }
      );
    }

    const proof = await verifyOracleExecutionTx({ execute_tx_signature: request.execute_tx_signature });
    if (!proof.ok) {
      return jsonResponse(
        {
          error: {
            code: 'onchain_oracle_validation_failed',
            message: proof.reason || 'On-chain oracle validation failed',
          },
        },
        { status: 400 }
      );
    }

    const buyArgs = toolArgs as ConditionalBuySolParams;
    const response: { messages: AgentMessage[] } = {
      messages: [
        {
          type: 'text',
          content: `Aprobación on-chain validada. Compra condicional ejecutada (simulada): ${buyArgs.input_amount} USDC para SOL con target ${buyArgs.target_price_usd} USD.`,
          execute: {
            status: 'success',
            tx_hash: request.execute_tx_signature,
          },
          timestamp: now(),
        },
      ],
    };
    return jsonResponse(response, { status: 200 });
  }

  const transferArgs = toolArgs as TransferParams;
  if (!session.userAddress) {
    return jsonResponse(
      { error: { code: 'no_wallet', message: 'No wallet connected in session' } },
      { status: 400 }
    );
  }

  let unsignedTx: { txBase64: string; blockhash: string; lastValidBlockHeight: number };
  try {
    unsignedTx = await buildUnsignedSolTransferTx({
      fromWallet: session.userAddress,
      toWallet: transferArgs.recipient,
      amountSol: transferArgs.amount,
    });
  } catch (e) {
    return jsonResponse(
      {
        error: {
          code: 'tx_build_failed',
          message: e instanceof Error ? e.message : 'Failed to build transfer transaction',
        },
      },
      { status: 500 }
    );
  }

  const shortRecipient = `${transferArgs.recipient.slice(0, 4)}...${transferArgs.recipient.slice(-4)}`;

  const response: { messages: AgentMessage[] } = {
    messages: [
      {
        type: 'text',
        content: `Transacción preparada. Revisa y firma en tu wallet para enviar ${transferArgs.amount} ${transferArgs.token || 'SOL'} a ${shortRecipient}.`,
        execute: {
          status: 'success',
          tx_hash: unsignedTx.blockhash,
        },
        timestamp: now(),
      },
    ],
  };

  return jsonResponse(
    {
      ...response,
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: unsignedTx.txBase64,
        recent_blockhash: unsignedTx.blockhash,
        last_valid_block_height: unsignedTx.lastValidBlockHeight,
        network: 'devnet',
      },
    },
    { status: 200 }
  );
}

// ============================================================================
// Function Reject Handler (JSON)
// ============================================================================

async function handleFunctionReject(request: {
  type: 'function_reject';
  session_id: string;
  reason?: string;
}): Promise<Response> {
  if (!request.session_id?.trim()) {
    return jsonResponse({ error: { code: 'invalid_payload', message: 'session_id is required' } }, { status: 400 });
  }

  const session = getSession(request.session_id);
  if (!session) {
    return jsonResponse({ error: { code: 'session_not_found', message: 'Session not found or expired' } }, { status: 404 });
  }

  if (!session.pendingProposal) {
    return jsonResponse({ error: { code: 'no_pending_proposal', message: 'No pending proposal for this session' } }, { status: 400 });
  }

  clearPendingProposal(request.session_id);

  console.log(`[chat] Proposal rejected: ${request.session_id}${request.reason ? ` - ${request.reason}` : ''}`);

  const response: { messages: AgentMessage[] } = {
    messages: [
      {
        type: 'text',
        content: 'Entendido, cancelé la transferencia. ¿Hay algo más en lo que pueda ayudarte?',
        timestamp: now(),
      },
    ],
  };

  return jsonResponse(response, { status: 200 });
}

// ============================================================================
// Exports for tests
// ============================================================================

export function normalizeMessages(input: unknown): { role: string; content: string }[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const normalized: { role: string; content: string }[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const msg = item as Record<string, unknown>;
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return null;
    normalized.push({ role: msg.role, content: msg.content });
  }
  return normalized;
}
