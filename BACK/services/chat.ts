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
  type SessionState,
  type PendingProposal,
  type ProposalState,
  type SolanaNetwork,
} from './chatSessionStore';
import {
  prepareTransferResult,
  generateTransferDisplay,
  assessTransferRisk,
  type TransferParams,
} from './tools/transfer';
import {
  evaluateConditionalBuy,
  type ConditionalBuySolParams,
  type ConditionalBuyOrderTxInput,
  buildConditionalBuyCreateOrderTx,
  toConditionalBuyProposalPayload,
} from './tools/conditionalBuySol';
import { quoteOrcaUsdcToSol, type OrcaSwapParams } from './tools/orcaSwap';
import { buildUnsignedOrcaSwapTx } from './tools/orcaSwapTx';
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
    }
  | {
      type: 'function_result';
      session_id: string;
      tx_signature: string;
      status: 'submitted' | 'confirmed' | 'failed';
      error_message?: string;
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
    name: 'transfer' | 'conditional_buy_sol' | 'swap_orca_usdc_to_sol';
    params: TransferParams | ConditionalBuySolParams | OrcaSwapParams;
  };
  execution?: {
    mode: 'phantom_sign_and_send' | 'phantom_execute_then_optional_backend_proof';
    network: 'devnet' | 'mainnet-beta';
    expires_at: string;
    expected_user_address?: string;
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
    'No ejecuta swap real; prepara una orden real de escrow en cadena, validada por oracle on-chain.',
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
      desired_sol_amount: {
        type: 'number',
        description: 'Cantidad de SOL objetivo para la orden (opcional)',
      },
      min_sol_out: {
        type: 'number',
        description: 'Cantidad mínima de SOL esperada (opcional)',
      },
    },
    required: ['input_token', 'input_amount', 'target_price_usd'],
  },
};

const ORCA_SWAP_TOOL: ResponsesToolDefinition = {
  type: 'function',
  name: 'swap_orca_usdc_to_sol',
  description:
    'Prepara un swap real en Orca devnet entre USDC y SOL. ' +
    'Usar cuando el usuario pida swap USDC->SOL o SOL->USDC.',
  parameters: {
    type: 'object',
    properties: {
      input_token: { type: 'string', enum: ['USDC', 'SOL'] },
      output_token: { type: 'string', enum: ['USDC', 'SOL'] },
      input_amount: { type: 'number', description: 'Monto de USDC a convertir' },
      slippage_bps: { type: 'number', description: 'Slippage en bps (default 100 = 1%)' },
    },
    required: ['input_token', 'output_token', 'input_amount'],
  },
};

const ALL_TOOLS = [TRANSFER_TOOL, CONDITIONAL_BUY_SOL_TOOL, ORCA_SWAP_TOOL];

const DEFAULT_SOLANA_NETWORK: SolanaNetwork = 'devnet';
const PROPOSAL_TTL_MS = 5 * 60 * 1000;

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

function getProposalExpiry(): number {
  return Date.now() + PROPOSAL_TTL_MS;
}

function isProposalExpired(proposal: PendingProposal): boolean {
  return Date.now() > proposal.expiresAt;
}

function isProposalBlocking(proposal: PendingProposal): boolean {
  return ['awaiting_approval', 'preparing_transaction', 'awaiting_signature', 'submitted', 'confirming'].includes(
    proposal.state,
  );
}

function normalizeChatError(err: unknown): { code: string; message: string } {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown error');

  if (rawMessage.includes('content_filter')) {
    return {
      code: 'content_filter',
      message: 'El proveedor de IA bloqueó ese pedido. Probá reformularlo con monto, token y destinatario.',
    };
  }

  if (rawMessage.includes('OPENAI_API_KEY')) {
    return {
      code: 'missing_api_key',
      message: 'Falta configurar la API key del proveedor de IA.',
    };
  }

  return {
    code: 'stream_error',
    message: 'No pude completar la respuesta. Probá de nuevo en unos segundos.',
  };
}

function getSolanaConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new web3.Connection(rpcUrl, 'confirmed');
}

async function buildUnsignedSolTransferTx(params: {
  fromWallet: string;
  toWallet: string;
  amountSol: number;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
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

  const { blockhash, lastValidBlockHeight } = params.recentBlockhash
    ? { blockhash: params.recentBlockhash, lastValidBlockHeight: params.lastValidBlockHeight ?? 0 }
    : await connection.getLatestBlockhash('confirmed');

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
    case 'function_result':
      return handleFunctionResult(request);
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
        'Eres un asistente de wallet para Solana llamado Compass. ' +
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
        (o) => o.type === 'function_call' && (o.name === 'transfer' || o.name === 'conditional_buy_sol' || o.name === 'swap_orca_usdc_to_sol')
      );

        if (toolCall && toolCall.name) {
        if (toolCall.name === 'transfer') {
          await handleTransferToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            session.userAddress,
            session,
            writer,
            encoder,
            conversationInput,
            systemInstruction
          );
        } else if (toolCall.name === 'conditional_buy_sol') {
          await handleConditionalBuyToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            session,
            writer,
            encoder
          );
        } else {
          await handleOrcaSwapToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            session,
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
      await writeSSE(writer, encoder, 'error', normalizeChatError(err));
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

async function handleOrcaSwapToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  session: SessionState,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  let toolArgs: OrcaSwapParams;
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    toolArgs = {
      input_token: parsed.input_token,
      output_token: parsed.output_token,
      input_amount: parsed.input_amount,
      slippage_bps: parsed.slippage_bps,
    } as OrcaSwapParams;
  } catch {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Could not parse swap_orca_usdc_to_sol args',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  try {
    const quote = await quoteOrcaUsdcToSol(toolArgs);

    updateSession(sessionId, {
      pendingProposal: {
        proposalType: 'swap_orca_usdc_to_sol',
        state: 'awaiting_approval',
        toolName: 'swap_orca_usdc_to_sol',
        toolArgs: { ...toolArgs, quote },
        toolResult: { status: 'prepared', reason: 'READY_FOR_ORCA_SWAP_APPROVAL' },
        createdAt: Date.now(),
        expiresAt: getProposalExpiry(),
        expectedUserAddress: session.userAddress,
        network: DEFAULT_SOLANA_NETWORK,
      },
    });

    const outAmount =
      toolArgs.output_token === 'SOL'
        ? Number(quote.estimated_output_base_units) / 1_000_000_000
        : Number(quote.estimated_output_base_units) / 1_000_000;
    const proposal: AgentFunctionCallMessage = {
      type: 'function_call',
      function: { name: 'swap_orca_usdc_to_sol', params: toolArgs },
      display: {
        summary: `Swap Orca: ${toolArgs.input_amount} ${toolArgs.input_token} -> ~${outAmount.toFixed(6)} ${toolArgs.output_token}`,
        provider: 'orca_whirlpools_devnet',
      },
      risk: {
        score: 35,
        level: 'medium',
        reasons: ['Ejecución real de swap en Orca devnet', `Slippage ${quote.slippage_bps} bps`],
      },
      timestamp: now(),
    };

    await writeSSE(writer, encoder, 'proposal', proposal);
    await writeSSE(writer, encoder, 'done', { session_id: sessionId, awaiting_approval: true });
    await writer.close();
  } catch (e) {
    await writeSSE(writer, encoder, 'error', {
      code: 'orca_quote_failed',
      message: e instanceof Error ? e.message : 'Orca quote failed',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
  }
}

async function handleConditionalBuyToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  session: SessionState,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  const existingPendingProposal = session.pendingProposal;
  if (existingPendingProposal && isProposalBlocking(existingPendingProposal) && !isProposalExpired(existingPendingProposal)) {
    await writeSSE(writer, encoder, 'error', {
      code: 'proposal_in_progress',
      message: 'Ya existe una propuesta pendiente. Resuélvela antes de pedir otra.',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }
  if (existingPendingProposal && isProposalExpired(existingPendingProposal)) {
    clearPendingProposal(sessionId);
  }

  let toolArgs: ConditionalBuySolParams;
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    const requestedAmount = Number(parsed.input_amount);
    const requestedTarget = Number(parsed.target_price_usd);

    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new Error('invalid_input_amount');
    }
    if (!Number.isFinite(requestedTarget) || requestedTarget <= 0) {
      throw new Error('invalid_target_price');
    }

    const recipient = typeof parsed.recipient === 'string' ? parsed.recipient : session.userAddress || '';
    if (!recipient) {
      await writeSSE(writer, encoder, 'error', {
        code: 'no_wallet',
        message: 'No wallet connected. Please connect your wallet first.',
      });
      await writeSSE(writer, encoder, 'done', { session_id: sessionId });
      await writer.close();
      return;
    }

    const desiredSolOut = Number(parsed.desired_sol_amount);
    const minSolOut = Number(parsed.min_sol_out);
    const requestedRecipient = typeof parsed.recipient === 'string' ? parsed.recipient : undefined;
    const requestClientOrder = Number(parsed.client_order_id);
    const requestMaxUsdc = Number(parsed.max_usdc_in);
    const requestOracleAge = Number(parsed.max_oracle_age_seconds);
    const requestConfidence = Number(parsed.max_confidence_bps);

    toolArgs = {
      input_token: 'USDC',
      input_amount: requestedAmount,
      target_price_usd: requestedTarget,
      min_sol_out: Number.isFinite(minSolOut) && minSolOut > 0 ? minSolOut : undefined,
      desired_sol_amount:
        Number.isFinite(desiredSolOut) && desiredSolOut > 0 ? desiredSolOut : undefined,
      client_order_id:
        Number.isFinite(requestClientOrder) && requestClientOrder > 0 ? Math.floor(requestClientOrder) : undefined,
      recipient: requestedRecipient || recipient,
      expires_at: parsed.expires_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      max_usdc_in: Number.isFinite(requestMaxUsdc) && requestMaxUsdc > 0 ? requestMaxUsdc : undefined,
      max_oracle_age_seconds: Number.isFinite(requestOracleAge) && requestOracleAge > 0 ? requestOracleAge : undefined,
      max_confidence_bps: Number.isFinite(requestConfidence) && requestConfidence > 0 ? requestConfidence : undefined,
      execution_mode: 'create_order_and_deposit',
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

  const quoteUsdPrice = Math.max(1, Number(toolArgs.target_price_usd));
  const proposalPayload = toConditionalBuyProposalPayload(toolArgs, session.userAddress || '', quoteUsdPrice);
  const decision = evaluateConditionalBuy({
    ...toolArgs,
    desired_sol_amount: proposalPayload.desired_sol_amount,
  });

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
      params: {
        ...toolArgs,
        ...proposalPayload,
      },
    },
    display: {
      summary: `Orden condicional para ${proposalPayload.desired_sol_amount} SOL si SOL <= ${toolArgs.target_price_usd} USD`,
      provider: 'conditional_escrow_program',
    },
    risk: {
      score: 35,
      level: 'medium',
      reasons: [
        'Compra condicional requiere validación oracle on-chain',
        ...decision.reasons,
      ],
    },
    execution: {
      mode: 'phantom_sign_and_send',
      network: DEFAULT_SOLANA_NETWORK,
      expires_at: new Date(getProposalExpiry()).toISOString(),
      expected_user_address: session.userAddress ?? undefined,
    },
    timestamp: now(),
  };

  updateSession(sessionId, {
    pendingProposal: {
      proposalType: 'conditional_buy_sol',
      state: 'awaiting_approval',
      toolName: 'conditional_buy_sol',
      toolArgs: {
        ...toolArgs,
        ...proposalPayload,
      },
      toolResult: {
        status: 'prepared',
        reason: 'READY_FOR_ONCHAIN_ORACLE_APPROVAL',
      },
      createdAt: Date.now(),
      expiresAt: getProposalExpiry(),
      expectedUserAddress: session.userAddress,
      network: DEFAULT_SOLANA_NETWORK,
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
  session: SessionState,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  conversationInput: string,
  systemInstruction: string
) {
  const existingPendingProposal = session.pendingProposal;
  if (existingPendingProposal && isProposalBlocking(existingPendingProposal) && !isProposalExpired(existingPendingProposal)) {
    await writeSSE(writer, encoder, 'error', {
      code: 'proposal_in_progress',
      message: 'Ya existe una propuesta pendiente. Resuélvela antes de pedir otra.',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }
  if (existingPendingProposal && isProposalExpired(existingPendingProposal)) {
    clearPendingProposal(sessionId);
  }

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
        proposalType: 'transfer',
        state: 'awaiting_approval',
        toolName: 'transfer',
        toolArgs,
        toolResult,
        createdAt: Date.now(),
        expiresAt: getProposalExpiry(),
        expectedUserAddress: userAddress,
        network: DEFAULT_SOLANA_NETWORK,
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
      execution: {
        mode: 'phantom_sign_and_send',
        network: DEFAULT_SOLANA_NETWORK,
        expires_at: new Date(getProposalExpiry()).toISOString(),
        expected_user_address: userAddress ?? undefined,
      },
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
  let streamedText = false;
  const writeToken = async (content: string) => {
    if (!content) return;
    streamedText = true;
    await writeSSE(writer, encoder, 'token', { content });
  };

  for await (const event of parseResponsesStream(responseStream)) {
    if (event.type === 'response.output_text.delta') {
      await writeToken(event.delta || '');
    } else if (event.type === 'response.content_part.delta') {
      await writeToken(event.delta?.text || '');
    } else if (event.type === 'response.output_item.added') {
      if (event.item?.type === 'message' && event.item?.content) {
        for (const part of event.item.content) {
          await writeToken(part.text || '');
        }
      }
    } else if (
      (event.type === 'response.output_text.done' ||
        event.type === 'response.content_part.done' ||
        event.type === 'response.output_item.done') &&
      streamedText
    ) {
      return;
    } else if (event.type === 'response.completed' && !streamedText) {
      const output = event.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === 'message' && item.content) {
            for (const part of item.content) {
              if (part.type === 'output_text') {
                await writeToken(part.text || '');
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

  const pendingProposal = session.pendingProposal;
  if (isProposalExpired(pendingProposal)) {
    clearPendingProposal(request.session_id);
    return jsonResponse({ error: { code: 'proposal_expired', message: 'Pending proposal expired' } }, { status: 400 });
  }

  const { toolArgs, toolName, expectedUserAddress } = pendingProposal;
  if (pendingProposal.state !== 'awaiting_approval' && pendingProposal.state !== 'failed') {
    return jsonResponse(
      { error: { code: 'proposal_state_conflict', message: `Cannot approve proposal in state ${pendingProposal.state}` } },
      { status: 400 }
    );
  }

  const preparedProposal = {
    ...pendingProposal,
    state: 'preparing_transaction' as ProposalState,
  };
  updateSession(request.session_id, { pendingProposal: preparedProposal });
  const proposal = getSession(request.session_id)?.pendingProposal;
  if (!proposal) {
    return jsonResponse({ error: { code: 'session_not_found', message: 'Session not found while preparing proposal' } }, { status: 404 });
  }

  console.log(`[chat] Proposal approved: ${request.session_id}`);

  if (toolName === 'conditional_buy_sol') {
    const buyArgs = toolArgs as ConditionalBuySolParams;
    if (!session.userAddress) {
      clearPendingProposal(request.session_id);
      return jsonResponse({ error: { code: 'no_wallet', message: 'No wallet connected in session' } }, { status: 400 });
    }
    if (proposal.expectedUserAddress && proposal.expectedUserAddress !== session.userAddress) {
      updateSession(request.session_id, {
        pendingProposal: {
          ...proposal,
          state: 'failed',
        },
      });
      return jsonResponse(
        { error: { code: 'wallet_mismatch', message: 'Connected wallet does not match expected wallet for this proposal.' } },
        { status: 400 },
      );
    }

    const normalizedQuote = Number(buyArgs.target_price_usd) || 1;
    const orderPayloadCandidate = toConditionalBuyProposalPayload(
      {
        input_token: 'USDC',
        input_amount: buyArgs.input_amount,
        target_price_usd: buyArgs.target_price_usd,
        min_sol_out: buyArgs.min_sol_out,
        desired_sol_amount: buyArgs.desired_sol_amount,
        max_usdc_in: buyArgs.max_usdc_in,
        max_oracle_age_seconds: buyArgs.max_oracle_age_seconds,
        max_confidence_bps: buyArgs.max_confidence_bps,
        recipient: buyArgs.recipient,
        expires_at: buyArgs.expires_at,
        oracle_feed_pubkey: buyArgs.oracle_feed_pubkey,
        client_order_id: buyArgs.client_order_id,
        execution_mode: 'create_order_and_deposit',
      },
      session.userAddress,
      normalizedQuote,
    );

    let unsignedCreateTx: { txBase64: string; blockhash: string; lastValidBlockHeight: number; orderPda: string; clientOrderId: number };
    try {
      const desiredSolAmount = orderPayloadCandidate.desired_sol_amount;
      if (!Number.isFinite(desiredSolAmount) || desiredSolAmount <= 0) {
        throw new Error('Cannot resolve desired SOL amount');
      }

      const maxUsdcIn = buyArgs.max_usdc_in || buyArgs.input_amount;
      const expiresAtUnix = typeof buyArgs.expires_at === 'string'
        ? Math.floor(new Date(buyArgs.expires_at).getTime() / 1000)
        : orderPayloadCandidate.expires_at_unix;

      const orderPayload: ConditionalBuyOrderTxInput = {
        userAddress: session.userAddress,
        desired_sol_amount: desiredSolAmount,
        desired_sol_lamports: orderPayloadCandidate.desired_sol_lamports,
        max_usdc_in: maxUsdcIn,
        target_price_usd: buyArgs.target_price_usd,
        recipient: buyArgs.recipient || session.userAddress,
        expires_at_unix: expiresAtUnix,
        client_order_id: orderPayloadCandidate.client_order_id,
        oracle_feed_pubkey: orderPayloadCandidate.oracle_feed_pubkey,
        max_oracle_age_seconds: orderPayloadCandidate.max_oracle_age_seconds,
        max_confidence_bps: orderPayloadCandidate.max_confidence_bps,
      };
      unsignedCreateTx = await buildConditionalBuyCreateOrderTx(orderPayload);
    } catch (e) {
      updateSession(request.session_id, {
        pendingProposal: {
          ...proposal,
          state: 'failed',
        },
      });
      return jsonResponse(
        {
          error: {
            code: 'conditional_order_build_failed',
            message: e instanceof Error ? e.message : 'Failed to build conditional order transaction',
          },
        },
        { status: 500 }
      );
    }

    const shortRecipient = `${(buyArgs.recipient || session.userAddress).slice(0, 4)}...${(buyArgs.recipient || session.userAddress).slice(-4)}`;

    const response: {
      messages: AgentMessage[];
      proposal_state: { state: 'awaiting_signature'; expires_at: string };
      transaction?: {
        format: 'base64_versioned_transaction';
        unsigned_tx_base64: string;
        recent_blockhash: string;
        last_valid_block_height: number;
        network: 'devnet' | 'mainnet-beta';
      };
    } = {
      messages: [
        {
          type: 'text',
          content: `Aprobación recibida para orden condicional (objetivo ${buyArgs.desired_sol_amount || buyArgs.min_sol_out || '—'} SOL, recipient ${shortRecipient}, max ${buyArgs.max_usdc_in || buyArgs.input_amount} USDC). Ejecuta la transacción en Phantom y luego confirma la propuesta.`,
          timestamp: now(),
        },
      ],
      proposal_state: {
        state: 'awaiting_signature',
        expires_at: proposal.expiresAt ? new Date(proposal.expiresAt).toISOString() : now(),
      },
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: unsignedCreateTx.txBase64,
        recent_blockhash: unsignedCreateTx.blockhash,
        last_valid_block_height: unsignedCreateTx.lastValidBlockHeight,
        network: proposal.network,
      },
    };

    updateSession(request.session_id, {
      pendingProposal: {
        ...proposal,
        state: 'awaiting_signature',
        recentBlockhash: unsignedCreateTx.blockhash,
        lastValidBlockHeight: unsignedCreateTx.lastValidBlockHeight,
        toolArgs: {
          ...(proposal.toolArgs as Record<string, unknown>),
          order_pda: unsignedCreateTx.orderPda,
        },
      },
    });
    return jsonResponse(response, { status: 200 });
  }

  if (toolName === 'swap_orca_usdc_to_sol') {
    const swapArgs = toolArgs as OrcaSwapParams & { quote?: unknown };
    if (!session.userAddress) {
      clearPendingProposal(request.session_id);
      return jsonResponse(
        { error: { code: 'no_wallet', message: 'No wallet connected in session' } },
        { status: 400 }
      );
    }

    let unsigned;
    try {
      unsigned = await buildUnsignedOrcaSwapTx({
        userAddress: session.userAddress,
        inputToken: swapArgs.input_token,
        outputToken: swapArgs.output_token,
        inputAmount: swapArgs.input_amount,
        slippageBps: swapArgs.slippage_bps,
      });
    } catch (e) {
      updateSession(request.session_id, {
        pendingProposal: {
          ...proposal,
          state: 'failed',
        },
      });
      return jsonResponse(
        {
          error: {
            code: 'orca_tx_build_failed',
            message: e instanceof Error ? e.message : 'Failed to build Orca swap transaction',
          },
        },
        { status: 500 }
      );
    }

    // Note: We don't set execute.status here because the transaction hasn't been signed/sent yet.
    // The frontend will sign, send, and set the real status + tx_hash.
    const response: {
      messages: AgentMessage[];
      proposal_state: { state: 'awaiting_signature'; expires_at: string };
      swap_execution: {
        provider: string;
        pair: string;
        input_amount: number;
        slippage_bps: number;
        quote: unknown;
      };
      transaction: {
        format: 'base64_versioned_transaction' | 'base64_legacy_transaction';
        unsigned_tx_base64: string;
        recent_blockhash: string;
        last_valid_block_height: number;
        network: 'devnet';
        execution_type: 'orca_swap';
      };
    } = {
      messages: [
        {
          type: 'text',
          content: `Swap preparado: ${swapArgs.input_amount} ${swapArgs.input_token} → ${swapArgs.output_token}. Firma en tu wallet para ejecutar.`,
          timestamp: now(),
        },
      ],
      proposal_state: {
        state: 'awaiting_signature',
        expires_at: new Date(proposal.expiresAt).toISOString(),
      },
      swap_execution: {
        provider: 'orca_whirlpools_devnet',
        pair: `${swapArgs.input_token}/${swapArgs.output_token}`,
        input_amount: swapArgs.input_amount,
        slippage_bps: swapArgs.slippage_bps ?? 100,
        quote: (swapArgs as any).quote ?? null,
      },
      transaction: {
        format: unsigned.isVersioned ? 'base64_versioned_transaction' : 'base64_legacy_transaction',
        unsigned_tx_base64: unsigned.unsignedTxBase64,
        recent_blockhash: unsigned.recentBlockhash,
        last_valid_block_height: unsigned.lastValidBlockHeight,
        network: 'devnet',
        execution_type: 'orca_swap',
      },
    };

    updateSession(request.session_id, {
      pendingProposal: {
        ...proposal,
        state: 'awaiting_signature',
        recentBlockhash: unsigned.recentBlockhash,
        lastValidBlockHeight: unsigned.lastValidBlockHeight,
      },
    });

    return jsonResponse(response, { status: 200 });
  }

  const transferArgs = toolArgs as TransferParams;
  if (!session.userAddress) {
    clearPendingProposal(request.session_id);
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
      recentBlockhash: proposal.recentBlockhash,
      lastValidBlockHeight: proposal.lastValidBlockHeight,
    });
  } catch (e) {
    updateSession(request.session_id, {
      pendingProposal: {
        ...proposal,
        state: 'failed',
      },
    });
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

  // Note: We don't set execute.status here because the transaction hasn't been signed/sent yet.
  // The frontend will sign, send, and set the real status + tx_hash.
  const response: { messages: AgentMessage[] } = {
    messages: [
      {
        type: 'text',
        content: `Transacción preparada. Revisa y firma en tu wallet para enviar ${transferArgs.amount} ${transferArgs.token || 'SOL'} a ${shortRecipient}.`,
        timestamp: now(),
      },
    ],
  };

  if (expectedUserAddress && expectedUserAddress !== session.userAddress) {
    clearPendingProposal(request.session_id);
    return jsonResponse(
      {
        error: {
          code: 'wallet_mismatch',
          message: 'Connected wallet does not match expected wallet for this proposal.',
        },
      },
      { status: 400 }
    );
  }

  const responseData: {
    messages: AgentMessage[];
    proposal_state: { state: 'awaiting_signature'; expires_at: string };
    transaction?: {
      format: 'base64_versioned_transaction';
      unsigned_tx_base64: string;
      recent_blockhash: string;
      last_valid_block_height: number;
      network: 'devnet' | 'mainnet-beta';
    };
  } = {
    ...response,
    proposal_state: {
      state: 'awaiting_signature',
      expires_at: new Date(proposal.expiresAt).toISOString(),
    },
    transaction: {
      format: 'base64_versioned_transaction',
      unsigned_tx_base64: unsignedTx.txBase64,
      recent_blockhash: unsignedTx.blockhash,
      last_valid_block_height: unsignedTx.lastValidBlockHeight,
      network: proposal.network,
    },
  };

  updateSession(request.session_id, {
    pendingProposal: {
      ...proposal,
      state: 'awaiting_signature',
      recentBlockhash: unsignedTx.blockhash,
      lastValidBlockHeight: unsignedTx.lastValidBlockHeight,
    },
  });

  return jsonResponse(responseData, { status: 200 });
}

// ============================================================================
// Function Result Handler (JSON)
// ============================================================================

async function handleFunctionResult(request: {
  type: 'function_result';
  session_id: string;
  tx_signature: string;
  status: 'submitted' | 'confirmed' | 'failed';
  error_message?: string;
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

  const pendingProposal = session.pendingProposal;
  if (pendingProposal.toolName === 'conditional_buy_sol' && request.status === 'confirmed' && request.error_message) {
    return jsonResponse(
      {
        error: {
          code: 'onchain_result_declined',
          message: request.error_message,
        },
      },
      { status: 400 },
    );
  }

  const statusToPersist = request.status === 'failed' ? 'failed' : request.status === 'confirmed' ? 'confirmed' : 'submitted';
  if (request.status === 'confirmed') {
    clearPendingProposal(request.session_id);
  } else {
    updateSession(request.session_id, {
      pendingProposal: {
        ...pendingProposal,
        state: request.status === 'submitted' ? 'submitted' : 'failed',
        txSignature: request.tx_signature,
      },
    });
  }

  const response: { messages: AgentMessage[] } = {
    messages: [
      {
        type: 'text',
        content:
          statusToPersist === 'failed'
            ? `Error en el resultado de ejecución: ${request.error_message || 'No se pudo completar.'}`
            : `Resultado registrado para la transacción (${request.status}).`,
        execute: {
          status: request.status === 'confirmed' || request.status === 'submitted' ? 'success' : 'failed',
          tx_hash: request.tx_signature,
          error: request.error_message,
        },
        timestamp: now(),
      },
    ],
  };

  return jsonResponse(response, { status: 200 });
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
