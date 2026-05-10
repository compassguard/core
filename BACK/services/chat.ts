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
  normalizeTransferToken,
  type TransferParams,
} from './tools/transfer';
import {
  buildTransferActionHash,
  buildTransferCanonicalParams,
  buildTransferMetadata,
  deriveWalletPolicyPda,
  evaluateWalletSafety,
  hasActionHashMismatch,
  isPendingActionExpired,
  type WalletSafetyDecisionResult,
  type WalletSafetyEvaluation,
} from './walletSafetyValidation';
import {
  evaluateConditionalBuy,
  type ConditionalBuySolParams,
  type ConditionalBuyOrderTxInput,
  buildConditionalBuyCreateOrderTx,
  toConditionalBuyProposalPayload,
} from './tools/conditionalBuySol';
import { DEVNET_USDC_MINT, quoteOrcaUsdcToSol, type OrcaSwapParams, type OrcaSwapQuote } from './tools/orcaSwap';
import { buildUnsignedOrcaSwapTx, buildUnsignedOrcaSwapTxWithGuard } from './tools/orcaSwapTx';
import { buildSwapGuardConfig, computeImpliedPrice, type SwapGuardConfig, type SwapGuardWarning } from './tools/swapGuard';
import { buildSwapGuardInstructions, getGuardProgramId, getPythOracleFeed } from './tools/swapGuardOnChain';
import {
  deriveActionApprovalAddress,
  deriveWalletSafetyAttestationAddress,
  fetchWalletSafetyAttestationAccount,
  verifyTransferGuardReadiness,
} from './onchainApproval';
import {
  callAzureResponsesStream,
  callAzureResponses,
  parseResponsesStream,
  type ResponsesToolDefinition,
} from './azureResponsesClient';
import { web3 } from '@coral-xyz/anchor';
import { fetchWalletHoldings } from './walletHoldings';
import { getUsdcSolQuote } from './priceQuote';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
      action_hash?: string;
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
    requiresExtraConfirmation?: boolean;
    walletSafety?: WalletSafetyDecisionResult;
  };
  onchain_guardrail?: {
    action_type: string;
    action_hash: string;
    policy_pda: string;
    action_approval_pda: string;
    wallet_safety_attestation_pda: string;
    action_expires_at: string;
    action_created_at: string;
    action_amount_lamports: number;
    action_recipient: string;
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
    'Prepara una transferencia de SOL a otra wallet de Solana. ' +
    'NO ejecuta la transferencia on-chain. Retorna una acción preparada que requiere aprobación del usuario. ' +
    'Usa esta herramienta cuando el usuario quiera enviar/transferir SOL a otra dirección.',
  parameters: {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        description: 'Cantidad a transferir (debe ser positiva)',
      },
      token: {
        type: 'string',
        description: 'Símbolo del token. En esta demo solo se soporta SOL.',
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

const GET_WALLET_HOLDINGS_TOOL: ResponsesToolDefinition = {
  type: 'function',
  name: 'get_wallet_holdings',
  description:
    'Consulta balances de la wallet conectada usando backend (SOL nativo + SPL) en devnet. ' +
    'No prepara ni ejecuta transacciones.',
  parameters: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: 'Dirección de wallet Solana',
      },
      network: {
        type: 'string',
        enum: ['devnet'],
      },
    },
    required: ['address'],
  },
};

const GET_USDC_SOL_QUOTE_TOOL: ResponsesToolDefinition = {
  type: 'function',
  name: 'get_usdc_sol_quote',
  description: 'Consulta una cotizacion devnet USDC/SOL de solo lectura para contexto del agente.',
  parameters: {
    type: 'object',
    properties: {
      input_token: {
        type: 'string',
        enum: ['USDC', 'SOL'],
      },
      output_token: {
        type: 'string',
        enum: ['USDC', 'SOL'],
      },
      input_amount: {
        type: 'number',
        description: 'Monto de entrada',
      },
      slippage_bps: {
        type: 'number',
        description: 'Slippage en bps',
      },
      network: {
        type: 'string',
        enum: ['devnet'],
      },
    },
    required: ['input_token', 'output_token', 'input_amount'],
  },
};

const READ_ONLY_AGENT_TOOL_NAMES = ['get_wallet_holdings', 'get_usdc_sol_quote'] as const;

export const ALL_TOOLS = [TRANSFER_TOOL, CONDITIONAL_BUY_SOL_TOOL, ORCA_SWAP_TOOL, GET_WALLET_HOLDINGS_TOOL, GET_USDC_SOL_QUOTE_TOOL];

export function getAgentToolNames(): string[] {
  return ALL_TOOLS.map((tool) => tool.name);
}

export function isReadOnlyAgentTool(toolName: string): boolean {
  return (READ_ONLY_AGENT_TOOL_NAMES as readonly string[]).includes(toolName);
}
const DEFAULT_SOLANA_NETWORK: SolanaNetwork = 'devnet';
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const USDC_FUNDING_BUFFER_MULTIPLIER = 1.15;
const MIN_USDC_FUNDING_SWAP_SOL = 0.05;
const DEV_USDC_FUNDING_SOL_PER_USDC = 0.06;
const TOKEN_PROGRAM_ID = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USER_POLICY_ACCOUNT_SPACE = 8 + 32 + 8 + 8 + 2 + 1 + 1 + 1 + 1;
const ACTION_APPROVAL_ACCOUNT_SPACE = 8 + 32 + 32 + 32 + 1 + 8 + 8 + 2 + 32 + 8 + 32 + 8 + 1 + 1 + 1;
const SOL_TRANSFER_FEE_BUFFER_LAMPORTS = 50_000;

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

function getRequiredUsdcForConditionalBuy(args: ConditionalBuySolParams): number {
  return Number(args.max_usdc_in || args.input_amount || 0);
}

function displaySwapToken(token: 'USDC' | 'SOL'): string {
  return token === 'USDC' ? 'devUSDC' : token;
}

async function getWalletUsdcTestBalance(userAddress: string): Promise<number> {
  const owner = new web3.PublicKey(userAddress);
  const usdcMint = process.env.USDC_TEST_MINT || DEVNET_USDC_MINT;
  const mint = new web3.PublicKey(usdcMint);
  const ata = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

  try {
    const balance = await getSolanaConnection().getTokenAccountBalance(ata, 'confirmed');
    return balance.value.uiAmount ?? Number(balance.value.amount) / 10 ** balance.value.decimals;
  } catch {
    return 0;
  }
}

async function buildUsdcFundingSwap(requiredUsdc: number, targetPriceUsd: number): Promise<{
  args: OrcaSwapParams;
  quote: Awaited<ReturnType<typeof quoteOrcaUsdcToSol>>;
}> {
  const quotePrice = Math.max(Number(targetPriceUsd) || 1, 1);
  const solInput = Math.max(
    MIN_USDC_FUNDING_SWAP_SOL,
    requiredUsdc * DEV_USDC_FUNDING_SOL_PER_USDC,
    (requiredUsdc * USDC_FUNDING_BUFFER_MULTIPLIER) / quotePrice,
  );
  const quote = await quoteOrcaUsdcToSol({
    input_token: 'SOL',
    output_token: 'USDC',
    input_amount: solInput,
    slippage_bps: 100,
  });

  return {
    args: {
      input_token: 'SOL',
      output_token: 'USDC',
      input_amount: Number(solInput.toFixed(6)),
      slippage_bps: 100,
    },
    quote,
  };
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

type MaskedSolanaAddresses = {
  content: string;
  addressByPlaceholder: Record<string, string>;
};

type DirectTransferIntent =
  | {
      matched: true;
      amount: number;
      token: string;
      recipient: string;
      recipientValid: boolean;
    }
  | { matched: false };

function isValidSolanaPubkey(value: string): boolean {
  try {
    new web3.PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function maskSolanaAddressesForModel(content: string): MaskedSolanaAddresses {
  const addressByPlaceholder: Record<string, string> = {};
  let index = 0;
  const contentWithMasks = content.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, (candidate) => {
    const existing = Object.entries(addressByPlaceholder).find(([, address]) => address === candidate)?.[0];
    if (existing) return existing;
    index += 1;
    const placeholder = `SOLANA_ADDRESS_${index}`;
    addressByPlaceholder[placeholder] = candidate;
    return placeholder;
  });

  return { content: contentWithMasks, addressByPlaceholder };
}

export function parseDirectTransferIntent(content: string): DirectTransferIntent {
  const normalized = content.trim();
  if (!/\b(manda|mand[aá]|envi[aá]|envia|transfer[ií]|transferir|send)\b/i.test(normalized)) {
    return { matched: false };
  }

  const amountMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*([A-Za-z]{2,10})\b/i);
  const recipientMatch = normalized.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  if (!amountMatch || !recipientMatch) {
    return { matched: false };
  }

  const amount = Number(amountMatch[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { matched: false };
  }

  const recipient = recipientMatch[0];
  return {
    matched: true,
    amount,
    token: normalizeTransferToken(amountMatch[2]).toUpperCase(),
    recipient,
    recipientValid: isValidSolanaPubkey(recipient),
  };
}

export function restoreMaskedSolanaAddressesInToolArgs(
  rawArguments: string | undefined,
  addressByPlaceholder: Record<string, string>
): string | undefined {
  if (!rawArguments || Object.keys(addressByPlaceholder).length === 0) return rawArguments;

  let restored = rawArguments;
  for (const [placeholder, address] of Object.entries(addressByPlaceholder)) {
    restored = restored.replaceAll(placeholder, address);
  }
  return restored;
}

function getSolanaConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new web3.Connection(rpcUrl, 'confirmed');
}

type SolTransferFundingCheck = {
  ok: boolean;
  balanceLamports: number;
  requiredLamports: number;
  missingLamports: number;
  amountLamports: number;
  overheadLamports: number;
  policyAccountMissing: boolean;
};

export function evaluateSolTransferFunding(params: {
  balanceLamports: number;
  amountLamports: number;
  policyRentLamports: number;
  approvalRentLamports: number;
  feeBufferLamports?: number;
  policyAccountMissing: boolean;
}): SolTransferFundingCheck {
  const overheadLamports =
    params.approvalRentLamports +
    (params.policyAccountMissing ? params.policyRentLamports : 0) +
    (params.feeBufferLamports ?? SOL_TRANSFER_FEE_BUFFER_LAMPORTS);
  const requiredLamports = params.amountLamports + overheadLamports;
  const missingLamports = Math.max(0, requiredLamports - params.balanceLamports);

  return {
    ok: missingLamports === 0,
    balanceLamports: params.balanceLamports,
    requiredLamports,
    missingLamports,
    amountLamports: params.amountLamports,
    overheadLamports,
    policyAccountMissing: params.policyAccountMissing,
  };
}

function formatLamportsAsSol(lamports: number): string {
  const sol = lamports / web3.LAMPORTS_PER_SOL;
  return sol.toLocaleString('es-AR', {
    minimumFractionDigits: sol < 1 ? 4 : 2,
    maximumFractionDigits: 6,
  });
}

async function checkSolTransferFunding(params: {
  userWallet: string;
  amountSol: number;
  policyPda: string;
}): Promise<SolTransferFundingCheck> {
  const connection = getSolanaConnection();
  const user = new web3.PublicKey(params.userWallet);
  const policy = new web3.PublicKey(params.policyPda);
  const amountLamports = Math.round(params.amountSol * web3.LAMPORTS_PER_SOL);

  const [balanceLamports, policyInfo, policyRentLamports, approvalRentLamports] = await Promise.all([
    connection.getBalance(user, 'confirmed'),
    connection.getAccountInfo(policy, 'confirmed'),
    connection.getMinimumBalanceForRentExemption(USER_POLICY_ACCOUNT_SPACE),
    connection.getMinimumBalanceForRentExemption(ACTION_APPROVAL_ACCOUNT_SPACE),
  ]);

  return evaluateSolTransferFunding({
    balanceLamports,
    amountLamports,
    policyRentLamports,
    approvalRentLamports,
    policyAccountMissing: !policyInfo,
  });
}

async function buildUnsignedSolTransferTx(params: {
  fromWallet: string;
  toWallet: string;
  amountSol: number;
  actionMetadata: {
    actionHash: string;
    policyPda: string;
    actionExpiresAt: string;
    includeCreateActionApproval?: boolean;
    includeWalletSafetyAttestation?: boolean;
    riskScoreBps?: number;
  };
}): Promise<{ txBase64: string; blockhash: string; lastValidBlockHeight: number }> {
  const connection = getSolanaConnection();
  const from = new web3.PublicKey(params.fromWallet);
  const to = new web3.PublicKey(params.toWallet);
  const lamports = Math.round(params.amountSol * web3.LAMPORTS_PER_SOL);

  const programId = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) {
    throw new Error('AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED');
  }

  const actionApprovalPda = deriveActionApprovalAddress({
    user: params.fromWallet,
    actionHash: params.actionMetadata.actionHash,
    programId,
  });
  const attestationPda = deriveWalletSafetyAttestationAddress({
    user: params.fromWallet,
    recipient: params.toWallet,
    actionHash: params.actionMetadata.actionHash,
    programId,
  });
  const policyPda = params.actionMetadata.policyPda;
  const actionHashBytes = Buffer.from(params.actionMetadata.actionHash, 'hex');
  const expiresAtUnix = Math.floor(new Date(params.actionMetadata.actionExpiresAt).getTime() / 1000);

  const actionDiscriminator = createHash('sha256')
    .update('global:guarded_transfer')
    .digest()
    .subarray(0, 8);
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(BigInt(lamports));

  const data = Buffer.concat([
    Buffer.from(actionDiscriminator),
    actionHashBytes,
    amountBuffer,
    to.toBuffer(),
  ]);

  const instructions: web3.TransactionInstruction[] = [];

  if (params.actionMetadata.includeCreateActionApproval) {
    const policyInfo = await connection.getAccountInfo(new web3.PublicKey(policyPda));
    if (!policyInfo) {
      const initializePolicyDiscriminator = createHash('sha256')
        .update('global:initialize_policy')
        .digest()
        .subarray(0, 8);
      const initializePolicyData = Buffer.alloc(8 + 8 + 8 + 2 + 1 + 1 + 1);
      let policyOffset = 0;
      Buffer.from(initializePolicyDiscriminator).copy(initializePolicyData, policyOffset); policyOffset += 8;
      initializePolicyData.writeBigUInt64LE(BigInt(Math.max(lamports, 100 * web3.LAMPORTS_PER_SOL)), policyOffset); policyOffset += 8;
      initializePolicyData.writeBigUInt64LE(BigInt(100_000_000_000), policyOffset); policyOffset += 8;
      initializePolicyData.writeUInt16LE(500, policyOffset); policyOffset += 2;
      initializePolicyData.writeUInt8(0, policyOffset); policyOffset += 1;
      initializePolicyData.writeUInt8(1, policyOffset); policyOffset += 1;
      initializePolicyData.writeUInt8(1, policyOffset);

      instructions.push(new web3.TransactionInstruction({
        programId: new web3.PublicKey(programId),
        keys: [
          { pubkey: from, isSigner: true, isWritable: true },
          { pubkey: new web3.PublicKey(policyPda), isSigner: false, isWritable: true },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initializePolicyData,
      }));
    }
  }

  let attestor: web3.Keypair | null = null;
  if (params.actionMetadata.includeWalletSafetyAttestation) {
    attestor = parseAttestorKeypair();
    if (!attestor) {
      throw new Error('WALLET_SAFETY_ATTESTOR_SECRET_KEY_NOT_CONFIGURED');
    }

    const attestationDiscriminator = createHash('sha256')
      .update('global:upsert_wallet_safety_attestation')
      .digest()
      .subarray(0, 8);
    const attestationData = Buffer.alloc(8 + 32 + 32 + 32 + 8 + 2);
    let attestationOffset = 0;
    Buffer.from(attestationDiscriminator).copy(attestationData, attestationOffset); attestationOffset += 8;
    from.toBuffer().copy(attestationData, attestationOffset); attestationOffset += 32;
    actionHashBytes.copy(attestationData, attestationOffset); attestationOffset += 32;
    to.toBuffer().copy(attestationData, attestationOffset); attestationOffset += 32;
    attestationData.writeBigInt64LE(BigInt(expiresAtUnix), attestationOffset); attestationOffset += 8;
    attestationData.writeUInt16LE(
      Math.max(0, Math.min(10_000, Math.round(params.actionMetadata.riskScoreBps ?? 1_500))),
      attestationOffset,
    );

    instructions.push(new web3.TransactionInstruction({
      programId: new web3.PublicKey(programId),
      keys: [
        { pubkey: attestor.publicKey, isSigner: true, isWritable: true },
        { pubkey: new web3.PublicKey(policyPda), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(attestationPda.address), isSigner: false, isWritable: true },
        { pubkey: getAttestorConfigPda(programId), isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: attestationData,
    }));
  }

  if (params.actionMetadata.includeCreateActionApproval) {
    const createDiscriminator = createHash('sha256')
      .update('global:create_action_approval')
      .digest()
      .subarray(0, 8);
    const createData = Buffer.alloc(8 + 32 + 32 + 1 + 8 + 8 + 2 + 32 + 8 + 32 + 8);
    let offset = 0;
    Buffer.from(createDiscriminator).copy(createData, offset); offset += 8;
    new web3.PublicKey(programId).toBuffer().copy(createData, offset); offset += 32;
    actionHashBytes.copy(createData, offset); offset += 32;
    createData.writeUInt8(5, offset); offset += 1;
    createData.writeBigUInt64LE(BigInt(lamports), offset); offset += 8;
    createData.writeBigUInt64LE(BigInt(0), offset); offset += 8;
    createData.writeUInt16LE(0, offset); offset += 2;
    to.toBuffer().copy(createData, offset); offset += 32;
    createData.writeBigUInt64LE(BigInt(0), offset); offset += 8;
    web3.SystemProgram.programId.toBuffer().copy(createData, offset); offset += 32;
    createData.writeBigInt64LE(BigInt(expiresAtUnix), offset);

    instructions.push(new web3.TransactionInstruction({
      programId: new web3.PublicKey(programId),
      keys: [
        { pubkey: from, isSigner: true, isWritable: true },
        { pubkey: new web3.PublicKey(policyPda), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(actionApprovalPda.address), isSigner: false, isWritable: true },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: createData,
    }));
  }

  instructions.push(new web3.TransactionInstruction({
    programId: new web3.PublicKey(programId),
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: new web3.PublicKey(policyPda), isSigner: false, isWritable: true },
      { pubkey: new web3.PublicKey(actionApprovalPda.address), isSigner: false, isWritable: true },
      { pubkey: new web3.PublicKey(attestationPda.address), isSigner: false, isWritable: false },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const msg = new web3.TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new web3.VersionedTransaction(msg);
  if (attestor) {
    tx.sign([attestor]);
  }
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');

  return { txBase64, blockhash, lastValidBlockHeight };
}

function parseAttestorKeypair(): web3.Keypair | null {
  const raw = process.env.WALLET_SAFETY_ATTESTOR_SECRET_KEY
    || (process.env.WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE
      ? readFileSync(process.env.WALLET_SAFETY_ATTESTOR_SECRET_KEY_FILE, 'utf8')
      : '');
  if (!raw) return null;

  try {
    if (raw.trim().startsWith('[')) {
      return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    return web3.Keypair.fromSecretKey(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
}

function getAttestorConfigPda(programId: string): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('attestor_config')],
    new web3.PublicKey(programId),
  )[0];
}

async function ensureWalletSafetyAttestation(params: {
  user: string;
  recipient: string;
  actionHash: string;
  actionExpiresAt: string;
  riskScoreBps: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const programId = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) return { ok: false, reason: 'AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED' };

  const attestor = parseAttestorKeypair();
  if (!attestor) {
    return { ok: true, reason: 'WALLET_SAFETY_ATTESTOR_SECRET_KEY_NOT_CONFIGURED' };
  }

  const existing = await fetchWalletSafetyAttestationAccount({
    user: params.user,
    recipient: params.recipient,
    actionHash: params.actionHash,
    programId,
  });
  const expiresAtUnix = Math.floor(new Date(params.actionExpiresAt).getTime() / 1000);
  const nowUnix = Math.floor(Date.now() / 1000);
  if (
    existing?.active &&
    existing.action_hash === params.actionHash &&
    existing.user === params.user &&
    existing.recipient === params.recipient &&
    existing.expires_at > nowUnix
  ) {
    return { ok: true };
  }

  const connection = getSolanaConnection();
  const attestationPda = deriveWalletSafetyAttestationAddress({
    user: params.user,
    recipient: params.recipient,
    actionHash: params.actionHash,
    programId,
  });
  const discriminator = createHash('sha256')
    .update('global:upsert_wallet_safety_attestation')
    .digest()
    .subarray(0, 8);
  const data = Buffer.alloc(8 + 32 + 32 + 32 + 8 + 2);
  let offset = 0;
  Buffer.from(discriminator).copy(data, offset); offset += 8;
  new web3.PublicKey(params.user).toBuffer().copy(data, offset); offset += 32;
  Buffer.from(params.actionHash, 'hex').copy(data, offset); offset += 32;
  new web3.PublicKey(params.recipient).toBuffer().copy(data, offset); offset += 32;
  data.writeBigInt64LE(BigInt(expiresAtUnix), offset); offset += 8;
  data.writeUInt16LE(Math.max(0, Math.min(10_000, Math.round(params.riskScoreBps))), offset);

  const ix = new web3.TransactionInstruction({
    programId: new web3.PublicKey(programId),
    keys: [
      { pubkey: attestor.publicKey, isSigner: true, isWritable: true },
      { pubkey: new web3.PublicKey(deriveWalletPolicyPda({ userWallet: params.user })), isSigner: false, isWritable: false },
      { pubkey: new web3.PublicKey(attestationPda.address), isSigner: false, isWritable: true },
      { pubkey: getAttestorConfigPda(programId), isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = attestor.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(attestor);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return { ok: true };
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
        'Cuando el usuario pida transferir SOL, usa la herramienta transfer. ' +
        'En esta demo no prepares transferencias de otros tokens con la herramienta transfer. ' +
        'Cuando el usuario pida comprar SOL solo si el precio está por debajo de X, usa la herramienta conditional_buy_sol. ' +
        'Cuando el usuario pida conocer el saldo real de su wallet, usa get_wallet_holdings. ' +
        'Cuando el usuario pida una cotizacion de conversion USDC/SOL, usa get_usdc_sol_quote. ' +
        'IMPORTANTE: NUNCA digas que ejecutaste una transferencia on-chain. Solo puedes preparar la acción y pedir aprobación del usuario. ' +
        'Responde en español de forma concisa y amigable.';

      const maskedUserInput = maskSolanaAddressesForModel(request.content);
      const conversationInput = `[Usuario]: ${maskedUserInput.content}`;
      const directTransferIntent = parseDirectTransferIntent(request.content);
      if (directTransferIntent.matched) {
        if (!directTransferIntent.recipientValid) {
          await writeSSE(writer, encoder, 'error', {
            code: 'invalid_recipient',
            message:
              'La dirección de destino no parece ser una dirección válida de Solana. Revisá que esté completa y volvé a intentarlo.',
          });
          await writeSSE(writer, encoder, 'done', { session_id: sessionId });
          return;
        }

        await handleTransferToolCall(
          {
            name: 'transfer',
            arguments: JSON.stringify({
              amount: directTransferIntent.amount,
              token: directTransferIntent.token,
              recipient: directTransferIntent.recipient,
            }),
          },
          sessionId,
          session.userAddress,
          session,
          writer,
          encoder,
          conversationInput,
          systemInstruction
        );
        return;
      }

      // First call: check if model wants to use tools
      const initialResponse = await callAzureResponses({
        input: conversationInput,
        instructions: systemInstruction,
        tools: ALL_TOOLS,
        maxOutputTokens: 4096,
      });

      // Check for tool calls in output
      const toolCall = initialResponse.output?.find(
        (o) =>
          o.type === 'function_call' &&
          (o.name === 'transfer' ||
            o.name === 'conditional_buy_sol' ||
            o.name === 'swap_orca_usdc_to_sol' ||
            o.name === 'get_wallet_holdings' ||
            o.name === 'get_usdc_sol_quote')
      );

        if (toolCall && toolCall.name) {
        if (toolCall.name === 'transfer') {
          await handleTransferToolCall(
            {
              name: toolCall.name,
              arguments: restoreMaskedSolanaAddressesInToolArgs(
                toolCall.arguments,
                maskedUserInput.addressByPlaceholder,
              ),
            },
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
            {
              name: toolCall.name,
              arguments: restoreMaskedSolanaAddressesInToolArgs(
                toolCall.arguments,
                maskedUserInput.addressByPlaceholder,
              ),
            },
            sessionId,
            session,
            writer,
            encoder
          );
        } else if (toolCall.name === 'get_wallet_holdings') {
          await handleGetWalletHoldingsToolCall(
            {
              name: toolCall.name,
              arguments: restoreMaskedSolanaAddressesInToolArgs(
                toolCall.arguments,
                maskedUserInput.addressByPlaceholder,
              ),
            },
            sessionId,
            session.userAddress,
            writer,
            encoder,
          );
        } else if (toolCall.name === 'get_usdc_sol_quote') {
          await handleGetUsdcSolQuoteToolCall(
            { name: toolCall.name, arguments: toolCall.arguments },
            sessionId,
            session.userAddress,
            writer,
            encoder,
          );
        } else {
          await handleOrcaSwapToolCall(
            {
              name: toolCall.name,
              arguments: restoreMaskedSolanaAddressesInToolArgs(
                toolCall.arguments,
                maskedUserInput.addressByPlaceholder,
              ),
            },
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

    const proposal: AgentFunctionCallMessage = {
      type: 'function_call',
      function: { name: 'swap_orca_usdc_to_sol', params: toolArgs },
      display: {
        summary: `Swap Orca: ${toolArgs.input_amount} ${displaySwapToken(toolArgs.input_token)} -> ${displaySwapToken(toolArgs.output_token)}`,
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

async function handleGetWalletHoldingsToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  userAddress: string | undefined,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  let rawAddress: string | undefined;
  let network: string | undefined;
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}');
    rawAddress = parsed.address || userAddress;
    network = parsed.network;
  } catch {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Could not parse get_wallet_holdings args',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  if (!rawAddress) {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_wallet_address',
      message: 'Wallet address is required for holdings lookup',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  try {
    const holdings = await fetchWalletHoldings({
      address: rawAddress,
      network: network ?? 'devnet',
    });

    await writeSSE(writer, encoder, 'token', { content: JSON.stringify(holdings) });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
  } catch (error) {
    const errorCode = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : 'Unable to fetch wallet holdings.';
    if (errorCode === 'invalid_address') {
      await writeSSE(writer, encoder, 'error', { code: 'invalid_tool_args', message });
    } else if (errorCode === 'unsupported_network') {
      await writeSSE(writer, encoder, 'error', { code: 'unsupported_network', message });
    } else {
      await writeSSE(writer, encoder, 'error', { code: 'provider_error', message });
    }
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
  }
}

async function handleGetUsdcSolQuoteToolCall(
  toolCall: { name: string; arguments?: string },
  sessionId: string,
  userAddress: string | undefined,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  let args: {
    input_token?: string;
    output_token?: string;
    input_amount?: unknown;
    slippage_bps?: unknown;
    network?: string;
  };
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Could not parse get_usdc_sol_quote args',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  if (!args.input_token || !args.output_token || args.input_amount == null) {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'Missing required quote parameters',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  if (typeof args.input_amount !== 'number' || Number.isNaN(args.input_amount) || args.input_amount <= 0) {
    await writeSSE(writer, encoder, 'error', {
      code: 'invalid_tool_args',
      message: 'input_amount must be a positive number',
    });
    await writer.close();
    return;
  }

  try {
    const quote = await getUsdcSolQuote({
      input_token: String(args.input_token).toUpperCase() as 'USDC' | 'SOL',
      output_token: String(args.output_token).toUpperCase() as 'USDC' | 'SOL',
      input_amount: args.input_amount,
      ...(typeof args.slippage_bps === 'number' ? { slippage_bps: args.slippage_bps } : {}),
      network: args.network ?? 'devnet',
    });

    await writeSSE(writer, encoder, 'token', { content: JSON.stringify(quote) });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
  } catch (error) {
    const errorCode = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : 'Unable to fetch quote.';
    if (errorCode === 'invalid_pair' || errorCode === 'invalid_amount' || errorCode === 'invalid_quote_payload') {
      await writeSSE(writer, encoder, 'error', { code: 'invalid_tool_args', message });
    } else if (errorCode === 'unsupported_network') {
      await writeSSE(writer, encoder, 'error', { code: 'unsupported_network', message });
    } else {
      await writeSSE(writer, encoder, 'error', { code: 'provider_error', message });
    }
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

  const requiredUsdc = getRequiredUsdcForConditionalBuy(toolArgs);
  if (session.userAddress && requiredUsdc > 0) {
    let usdcBalance = 0;
    try {
      usdcBalance = await getWalletUsdcTestBalance(session.userAddress);
    } catch {
      usdcBalance = 0;
    }

    if (usdcBalance + 0.000001 < requiredUsdc) {
      try {
        const missingUsdc = Math.max(requiredUsdc - usdcBalance, 0);
        const fundingSwap = await buildUsdcFundingSwap(missingUsdc, toolArgs.target_price_usd);
        const swapArgs = fundingSwap.args;

        updateSession(sessionId, {
          pendingProposal: {
            proposalType: 'swap_orca_usdc_to_sol',
            state: 'awaiting_approval',
            toolName: 'swap_orca_usdc_to_sol',
            toolArgs: { ...swapArgs, quote: fundingSwap.quote },
            toolResult: {
              status: 'prepared',
              reason: 'DEV_USDC_REQUIRED_BEFORE_CONDITIONAL_ORDER',
              next_conditional_buy_args: {
                ...toolArgs,
                ...proposalPayload,
              },
            },
            createdAt: Date.now(),
            expiresAt: getProposalExpiry(),
            expectedUserAddress: session.userAddress,
            network: DEFAULT_SOLANA_NETWORK,
          },
        });

        const proposal: AgentFunctionCallMessage = {
          type: 'function_call',
          function: { name: 'swap_orca_usdc_to_sol', params: swapArgs },
          display: {
            summary: `Primero fondear devUSDC: ${swapArgs.input_amount} SOL -> devUSDC`,
            provider: 'orca_whirlpools_devnet',
          },
          risk: {
            score: 35,
            level: 'medium',
            reasons: [
              `Tu wallet tiene ${usdcBalance.toFixed(6)} devUSDC y la orden necesita ${requiredUsdc} devUSDC`,
              'Primero se prepara un swap real SOL -> devUSDC en Orca devnet',
            ],
          },
          execution: {
            mode: 'phantom_sign_and_send',
            network: DEFAULT_SOLANA_NETWORK,
            expires_at: new Date(getProposalExpiry()).toISOString(),
            expected_user_address: session.userAddress,
          },
          timestamp: now(),
        };

        await writeSSE(writer, encoder, 'alert', {
          severity: 'info',
          content:
            `Para crear la orden condicional primero necesitás devUSDC en la wallet. ` +
            `Preparé un swap Orca SOL -> devUSDC; cuando se confirme voy a dejar lista la propuesta condicional.`,
          timestamp: now(),
        });
        await writeSSE(writer, encoder, 'proposal', proposal);
        await writeSSE(writer, encoder, 'done', {
          session_id: sessionId,
          awaiting_approval: true,
          action_type: 'FUND_DEV_USDC_BEFORE_CONDITIONAL_BUY',
        });
        await writer.close();
        return;
      } catch (e) {
        await writeSSE(writer, encoder, 'alert', {
          severity: 'warning',
          content:
            `Tu wallet no tiene suficiente devUSDC para esta orden. ` +
            `Hacé primero un swap SOL -> devUSDC en Orca devnet y luego repetí la orden condicional.`,
          timestamp: now(),
        });
        await writeSSE(writer, encoder, 'done', { session_id: sessionId });
        await writer.close();
        return;
      }
    }
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

  if (toolResult.status !== 'prepared') {
    if (toolResult.reason === 'UNSUPPORTED_TOKEN') {
      await writeSSE(writer, encoder, 'error', {
        code: 'unsupported_token',
        message: `Por ahora esta demo solo prepara transferencias de SOL. Revisá el token e intentá de nuevo.`,
      });
      await writeSSE(writer, encoder, 'done', { session_id: sessionId });
      await writer.close();
      return;
    }

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

  let policyPda = '';
  try {
    policyPda = deriveWalletPolicyPda({ userWallet: userAddress });
  } catch (error) {
    await writeSSE(writer, encoder, 'error', {
      code: 'onchain_guard_config_missing',
      message: error instanceof Error ? error.message : 'No se pudo configurar el guardrail on-chain.',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  if (normalizeTransferToken(toolArgs.token).toUpperCase() === 'SOL') {
    let funding: SolTransferFundingCheck;
    try {
      funding = await checkSolTransferFunding({
        userWallet: userAddress,
        amountSol: toolArgs.amount,
        policyPda,
      });
    } catch (error) {
      console.warn('[chat] Balance precheck failed:', error);
      await writeSSE(writer, encoder, 'error', {
        code: 'balance_check_failed',
        message: 'No pude verificar el saldo de tu wallet en devnet. Reintentá en unos segundos antes de preparar la transferencia.',
      });
      await writeSSE(writer, encoder, 'done', { session_id: sessionId });
      await writer.close();
      return;
    }

    if (!funding.ok) {
      await writeSSE(writer, encoder, 'error', {
        code: 'insufficient_funds',
        message:
          `Tu wallet tiene ${formatLamportsAsSol(funding.balanceLamports)} SOL, pero esta operación necesita aproximadamente ` +
          `${formatLamportsAsSol(funding.requiredLamports)} SOL (${formatLamportsAsSol(funding.amountLamports)} SOL a enviar ` +
          '+ fees y validación por contrato). Bajá el monto o fondeá la wallet antes de continuar.',
      });
      await writeSSE(writer, encoder, 'done', { session_id: sessionId });
      await writer.close();
      return;
    }
  }

  const safety: WalletSafetyEvaluation = await evaluateWalletSafety({
    userWallet: userAddress,
    recipient: toolArgs.recipient,
    amount: toolArgs.amount,
    token: toolArgs.token,
    memo: toolArgs.memo,
  });

  if (safety.decisionResult.decision === 'REJECT') {
    const riskReasons = safety.decisionResult.reasons.map((reason) => `${reason.code}: ${reason.message}`);
    const rejectionMessage =
      `La transferencia fue bloqueada por reglas de seguridad: ${riskReasons.join(' | ')}` +
      '\n\nSi quieres, corrige los datos e intenta nuevamente.';
    const denialStream = await callAzureResponsesStream({
      input: conversationInput + `\n\n[Resultado de guardrail]: ${rejectionMessage}`,
      instructions: systemInstruction,
      maxOutputTokens: 1024,
    });

    await streamResponseToSSE(denialStream, writer, encoder);
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  const canonical = buildTransferCanonicalParams({
    userWallet: userAddress,
    recipient: safety.canonical.recipient,
    amount: safety.canonical.amount,
    token: safety.canonical.token,
    memo: safety.canonical.memo,
  });
  const proposalCreatedAt = Date.now();
  let actionMetadata: ReturnType<typeof buildTransferMetadata>;
  try {
    actionMetadata = buildTransferMetadata(canonical, proposalCreatedAt, { policyPda });
  } catch (error) {
    await writeSSE(writer, encoder, 'error', {
      code: 'onchain_guard_config_missing',
      message: error instanceof Error ? error.message : 'No se pudo configurar el guardrail on-chain.',
    });
    await writeSSE(writer, encoder, 'done', { session_id: sessionId });
    await writer.close();
    return;
  }

  const actionHash = actionMetadata.actionHash;
  const actionApprovalPda = deriveActionApprovalAddress({ user: userAddress, actionHash }).address;
  const walletSafetyAttestationPda = deriveWalletSafetyAttestationAddress({
    user: userAddress,
    recipient: canonical.recipient,
    actionHash,
  }).address;
  const risk = assessTransferRisk(
    {
      amount: canonical.amount,
      token: canonical.token,
      recipient: canonical.recipient,
      memo: canonical.memo,
    },
    safety.decisionResult
  );

  updateSession(sessionId, {
    pendingProposal: {
      proposalType: 'transfer',
      state: 'awaiting_approval',
      toolName: 'transfer',
      toolArgs: {
        amount: canonical.amount,
        token: canonical.token,
        recipient: canonical.recipient,
        memo: canonical.memo,
      },
      toolResult: {
        ...toolResult,
        walletSafety: safety.decisionResult,
        onchainGuard: {
          actionType: actionMetadata.actionType,
          actionHash,
          policyPda: actionMetadata.policyPda,
          actionApprovalPda,
          walletSafetyAttestationPda,
          actionExpiresAt: actionMetadata.actionExpiresAt,
          actionCreatedAt: actionMetadata.actionCreatedAt,
        },
      },
      createdAt: proposalCreatedAt,
      expiresAt: getProposalExpiry(),
      expectedUserAddress: userAddress,
      network: DEFAULT_SOLANA_NETWORK,
      actionHash,
      actionExpiry: safety.actionExpiry,
      policyPda,
      actionApprovalPda,
      walletSafetyAttestationPda,
      actionType: actionMetadata.actionType,
      actionCreatedAt: actionMetadata.actionCreatedAt,
      actionExpiresAt: actionMetadata.actionExpiresAt,
    },
  });

  console.log(`[chat] Proposal created: ${sessionId} - transfer ${canonical.amount} ${canonical.token}`);

  const display = generateTransferDisplay({
    amount: canonical.amount,
    token: canonical.token,
    recipient: canonical.recipient,
    memo: canonical.memo,
  });

  const proposal: AgentFunctionCallMessage = {
    type: 'function_call',
    function: {
      name: 'transfer',
      params: {
        amount: canonical.amount,
        token: canonical.token,
        recipient: canonical.recipient,
        memo: canonical.memo,
      },
    },
    display,
    risk: {
      ...risk,
      walletSafety: safety.decisionResult,
      requiresExtraConfirmation: safety.decisionResult.requiresExtraConfirmation,
    },
    execution: {
      mode: 'phantom_sign_and_send',
      network: DEFAULT_SOLANA_NETWORK,
      expires_at: new Date(getProposalExpiry()).toISOString(),
      expected_user_address: userAddress,
    },
    onchain_guardrail: {
      action_type: actionMetadata.actionType,
      action_hash: actionHash,
      policy_pda: actionMetadata.policyPda,
      action_approval_pda: actionApprovalPda,
      wallet_safety_attestation_pda: walletSafetyAttestationPda,
      action_expires_at: actionMetadata.actionExpiresAt,
      action_created_at: actionMetadata.actionCreatedAt,
      action_amount_lamports: actionMetadata.amountLamports,
      action_recipient: canonical.recipient,
    },
    timestamp: now(),
  };

  await writeSSE(writer, encoder, 'proposal', proposal);
  await writeSSE(writer, encoder, 'done', { session_id: sessionId, awaiting_approval: true });
  await writer.close();
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
  action_hash?: string;
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

  const {
    toolArgs,
    toolName,
    expectedUserAddress,
    createdAt,
    actionHash: pendingActionHash,
    actionExpiry,
    policyPda,
    actionApprovalPda,
    walletSafetyAttestationPda,
    actionType,
    actionExpiresAt,
    actionCreatedAt,
  } = pendingProposal;
  if (actionExpiry && isPendingActionExpired(actionExpiry)) {
    clearPendingProposal(request.session_id);
    return jsonResponse(
      { error: { code: 'pending_proposal_expired', message: 'La propuesta expiró y ya no puede aprobarse.' } },
      { status: 400 }
    );
  }
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
        onchain_guardrail?: NonNullable<AgentFunctionCallMessage['onchain_guardrail']>;
      };
    } = {
      messages: [
        {
          type: 'text',
          content: `Aprobación recibida para orden condicional (objetivo ${buyArgs.desired_sol_amount || buyArgs.min_sol_out || '—'} SOL, recipient ${shortRecipient}, max ${buyArgs.max_usdc_in || buyArgs.input_amount} devUSDC). Ejecuta la transacción en Phantom y luego confirma la propuesta.`,
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
    const swapArgs = toolArgs as OrcaSwapParams & { quote?: OrcaSwapQuote };
    if (!session.userAddress) {
      clearPendingProposal(request.session_id);
      return jsonResponse(
        { error: { code: 'no_wallet', message: 'No wallet connected in session' } },
        { status: 400 }
      );
    }

    // =========================================================================
    // SWAP GUARD ON-CHAIN: Build transaction with guard instructions
    // =========================================================================
    const swapGuardEnabled = process.env.SWAP_ORACLE_GUARD_ENABLED !== 'false';
    // Import connection from centralized module to avoid rate limiting
    const { getConnection } = await import('./solanaConnection');
    const connection = getConnection();

    // Get guard configuration from environment
    const maxDeviationBps = Number(process.env.SWAP_GUARD_MAX_DEVIATION_BPS || '500');
    const warningDeviationBps = Number(process.env.SWAP_GUARD_WARNING_DEVIATION_BPS || '150');
    // DEVNET HACK: Pyth legacy price accounts have stale data (years old!)
    // Use max u64 value to effectively disable staleness check on devnet
    // For mainnet with Pyth Pull, use proper values like 60
    const stalenessSeconds = Number(process.env.SWAP_GUARD_STALENESS_SECONDS || '9999999999');
    const maxConfidenceBps = Number(process.env.SWAP_GUARD_MAX_CONFIDENCE_BPS || '10000');

    let unsigned;
    let swapGuardConfig: SwapGuardConfig | null = null;
    let swapGuardWarning: SwapGuardWarning | null = null;

    try {
      if (swapGuardEnabled) {
        // Calculate implied price for guard validation
        const inputIsUsdc = swapArgs.input_token === 'USDC';
        const inputAmountBaseUnits = BigInt(
          Math.round(swapArgs.input_amount * (inputIsUsdc ? 1_000_000 : 1_000_000_000))
        );

        // Get a fresh quote to estimate output
        const quote = swapArgs.quote;
        const estimatedOutputBaseUnits = quote 
          ? BigInt(quote.estimated_output_base_units)
          : inputAmountBaseUnits; // fallback
        const minOutputBaseUnits = quote
          ? BigInt(quote.min_output_base_units)
          : estimatedOutputBaseUnits * BigInt(99) / BigInt(100);

        // Calculate implied price in USD with e8 precision
        // For USDC -> SOL: implied SOL price = USDC amount / SOL amount
        const inputAmountFloat = swapArgs.input_amount;
        const outputAmountFloat = inputIsUsdc
          ? Number(estimatedOutputBaseUnits) / 1_000_000_000
          : Number(estimatedOutputBaseUnits) / 1_000_000;

        const impliedPriceUsd = inputIsUsdc
          ? inputAmountFloat / outputAmountFloat  // SOL price in USD
          : outputAmountFloat / inputAmountFloat; // SOL price in USD (inverted)

        const quotedPriceUsdE8 = BigInt(Math.round(impliedPriceUsd * 100_000_000));

        console.log(`[swapGuard ON-CHAIN] Building guarded swap tx: ${swapArgs.input_amount} ${swapArgs.input_token} -> ${swapArgs.output_token}`);
        console.log(`[swapGuard ON-CHAIN] Implied price: $${impliedPriceUsd.toFixed(4)} (${quotedPriceUsdE8} e8)`);
        console.log(`[swapGuard ON-CHAIN] Max deviation: ${maxDeviationBps} bps, Staleness: ${stalenessSeconds}s`);

        // Build guard instructions
        const expiresAtUnix = Math.floor(Date.now() / 1000) + 300; // 5 minutes
        const guardInstructions = await buildSwapGuardInstructions(connection, {
          userAddress: session.userAddress,
          quotedPriceUsdE8,
          inputAmountBaseUnits,
          minOutputAmountBaseUnits: minOutputBaseUnits,
          maxSlippageBps: swapArgs.slippage_bps ?? 100,
          maxDeviationBps,
          stalenessSeconds,
          maxConfidenceBps,
          expiresAtUnix,
        });

        // Collect all guard instructions
        const ixList: web3.TransactionInstruction[] = [];
        if (guardInstructions.initializePolicyIx) {
          console.log('[swapGuard ON-CHAIN] Including initialize_policy instruction (first-time user)');
          ixList.push(guardInstructions.initializePolicyIx);
        }
        ixList.push(guardInstructions.createApprovalIx);
        ixList.push(guardInstructions.markExecutedIx);

        console.log(`[swapGuard ON-CHAIN] Total guard instructions: ${ixList.length}`);

        // Build combined transaction: guard + swap
        unsigned = await buildUnsignedOrcaSwapTxWithGuard({
          userAddress: session.userAddress,
          inputToken: swapArgs.input_token,
          outputToken: swapArgs.output_token,
          inputAmount: swapArgs.input_amount,
          slippageBps: swapArgs.slippage_bps,
          guardInstructions: ixList,
        });

        // Build swap guard config for response
        swapGuardConfig = {
          program_id: getGuardProgramId().toBase58(),
          oracle_feed: getPythOracleFeed().toBase58(),
          quoted_price_usd_e8: Number(quotedPriceUsdE8),
          warning_deviation_bps: warningDeviationBps,
          max_deviation_bps: maxDeviationBps,
          staleness_seconds: stalenessSeconds,
          max_confidence_bps: maxConfidenceBps,
          network: 'devnet',
          on_chain_enforcement: true,
          action_approval_pda: guardInstructions.actionApprovalPda.toBase58(),
        };

        // Check if we should show a warning (server-side estimate)
        // The actual enforcement happens on-chain, but we can pre-warn the user
        try {
          const serverGuardResult = await buildSwapGuardConfig(impliedPriceUsd, swapArgs.input_token, swapArgs.output_token);
          if (serverGuardResult.warning) {
            swapGuardWarning = serverGuardResult.warning;
            console.log(`[swapGuard ON-CHAIN] Pre-check warning: ${swapGuardWarning.message}`);
          }
          // Update config with oracle price from server check
          if (serverGuardResult.config.oracle_price_usd_e8) {
            swapGuardConfig.oracle_price_usd_e8 = serverGuardResult.config.oracle_price_usd_e8;
            swapGuardConfig.deviation_bps = serverGuardResult.config.deviation_bps;
          }
        } catch (e) {
          console.warn('[swapGuard ON-CHAIN] Server-side pre-check failed (non-blocking):', e);
        }

        console.log('[swapGuard ON-CHAIN] Transaction built successfully with on-chain guard');

      } else {
        // Guard disabled - build regular swap transaction
        console.log('[swapGuard] Guard disabled, building regular swap tx');
        unsigned = await buildUnsignedOrcaSwapTx({
          userAddress: session.userAddress,
          inputToken: swapArgs.input_token,
          outputToken: swapArgs.output_token,
          inputAmount: swapArgs.input_amount,
          slippageBps: swapArgs.slippage_bps,
        });
      }
    } catch (e) {
      console.error('[swapGuard ON-CHAIN] Error building guarded transaction:', e);
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
            message: e instanceof Error ? e.message : 'Failed to build Orca swap transaction with guard',
          },
        },
        { status: 500 }
      );
    }

    // Build message with optional warning
    let messageContent = `Swap preparado: ${swapArgs.input_amount} ${swapArgs.input_token} → ${swapArgs.output_token}. `;
    if (swapGuardEnabled) {
      messageContent += `🛡️ Protegido con validación de precio on-chain. `;
    }
    messageContent += `Firma en tu wallet para ejecutar.`;
    if (swapGuardWarning) {
      messageContent += ` ⚠️ ${swapGuardWarning.message}`;
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
        execution_type: 'orca_swap_guarded' | 'orca_swap';
      };
      swap_guard?: SwapGuardConfig;
      swap_guard_warning?: SwapGuardWarning;
    } = {
      messages: [
        {
          type: 'text',
          content: messageContent,
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
        execution_type: swapGuardEnabled ? 'orca_swap_guarded' : 'orca_swap',
      },
    };

    // Include swap_guard metadata if available
    if (swapGuardConfig) {
      response.swap_guard = swapGuardConfig;
      if (swapGuardWarning) {
        response.swap_guard_warning = swapGuardWarning;
      }
    }

    updateSession(request.session_id, {
      pendingProposal: {
        ...proposal,
        state: 'awaiting_signature',
        recentBlockhash: unsigned.recentBlockhash,
        lastValidBlockHeight: unsigned.lastValidBlockHeight,
        // Store swap guard info for later verification
        toolArgs: {
          ...swapArgs,
          swap_guard: swapGuardConfig,
        },
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

  const transferSafetyDecision = (proposal.toolResult as { walletSafety?: WalletSafetyDecisionResult } | undefined)
    ?.walletSafety;
  if (transferSafetyDecision?.decision === 'REJECT') {
    clearPendingProposal(request.session_id);
    return jsonResponse({ error: { code: 'proposal_rejected_by_policy', message: 'La propuesta no puede aprobarse por policy de seguridad.' } }, { status: 400 });
  }

  const canonicalForApprove = buildTransferCanonicalParams({
    userWallet: session.userAddress,
    recipient: transferArgs.recipient,
    amount: transferArgs.amount,
    token: transferArgs.token,
    memo: transferArgs.memo,
  });
  const expectedActionHash = buildTransferActionHash(canonicalForApprove, createdAt, { policyPda });
  if (!pendingActionHash || hasActionHashMismatch(expectedActionHash, pendingActionHash)) {
    clearPendingProposal(request.session_id);
    return jsonResponse({ error: { code: 'action_hash_mismatch', message: 'La propuesta fue alterada.' } }, { status: 409 });
  }
  if (request.action_hash && hasActionHashMismatch(request.action_hash, pendingActionHash)) {
    clearPendingProposal(request.session_id);
    return jsonResponse({ error: { code: 'action_hash_mismatch', message: 'El hash de aprobación no coincide con la propuesta.' } }, { status: 409 });
  }
  if (!policyPda) {
    return jsonResponse(
      {
        error: {
          code: 'onchain_guard_context_missing',
          message: 'No existe contexto de guardrail on-chain para esta propuesta.',
        },
      },
      { status: 400 }
    );
  }

  const expectedAmountLamports = Math.round(transferArgs.amount * web3.LAMPORTS_PER_SOL);
  const readiness = await verifyTransferGuardReadiness({
    user: session.userAddress,
    action_hash: pendingActionHash,
    recipient: transferArgs.recipient,
    amount_lamports: expectedAmountLamports,
    actionApprovalPda: actionApprovalPda || undefined,
    walletSafetyAttestationPda: walletSafetyAttestationPda || undefined,
    allowMissingApproval: true,
    allowMissingAttestation: true,
  });
  if (!readiness.ok) {
    clearPendingProposal(request.session_id);
    return jsonResponse(
      {
        error: {
          code: readiness.reason || 'onchain_guard_unready',
          message: `La propuesta no está lista para ejecución on-chain: ${readiness.reason || 'unknown'}`,
        },
      },
      { status: 409 }
    );
  }

  let unsignedTx: { txBase64: string; blockhash: string; lastValidBlockHeight: number };
  try {
    unsignedTx = await buildUnsignedSolTransferTx({
      fromWallet: session.userAddress,
      toWallet: transferArgs.recipient,
      amountSol: transferArgs.amount,
      actionMetadata: {
        actionHash: pendingActionHash,
        policyPda,
        actionExpiresAt: actionExpiresAt || actionExpiry || new Date(createdAt + 5 * 60 * 1000).toISOString(),
        includeCreateActionApproval: Boolean(readiness.actionApprovalMissing),
        includeWalletSafetyAttestation: Boolean(readiness.walletSafetyAttestationMissing),
        riskScoreBps: transferSafetyDecision?.riskLevel === 'critical' ? 8_500 : transferSafetyDecision?.riskLevel === 'medium' ? 5_000 : 1_500,
      },
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
        content: `Transacción preparada con guardrail on-chain. Revisa y firma en tu wallet para enviar ${transferArgs.amount} ${transferArgs.token || 'SOL'} a ${shortRecipient}.`,
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
      onchain_guardrail?: NonNullable<AgentFunctionCallMessage['onchain_guardrail']>;
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
      onchain_guardrail: {
        action_type: actionType || 'TRANSFER_SOL_GUARDED',
        action_hash: pendingActionHash,
        policy_pda: policyPda,
        action_approval_pda: actionApprovalPda || '',
        wallet_safety_attestation_pda: walletSafetyAttestationPda || '',
        action_expires_at: actionExpiresAt || actionExpiry || new Date(createdAt + 5 * 60 * 1000).toISOString(),
        action_created_at: actionCreatedAt || new Date(createdAt).toISOString(),
        action_amount_lamports: expectedAmountLamports,
        action_recipient: transferArgs.recipient,
      },
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

  if (
    pendingProposal.toolName === 'swap_orca_usdc_to_sol' &&
    request.status === 'confirmed' &&
    pendingProposal.toolResult?.reason === 'DEV_USDC_REQUIRED_BEFORE_CONDITIONAL_ORDER'
  ) {
    const nextArgs = pendingProposal.toolResult.next_conditional_buy_args as ConditionalBuySolParams | undefined;
    if (nextArgs) {
      const quoteUsdPrice = Math.max(1, Number(nextArgs.target_price_usd));
      const proposalPayload = toConditionalBuyProposalPayload(nextArgs, session.userAddress || '', quoteUsdPrice);
      const decision = evaluateConditionalBuy({
        ...nextArgs,
        desired_sol_amount: proposalPayload.desired_sol_amount,
      });

      if (decision.decision === 'REJECT') {
        clearPendingProposal(request.session_id);
        return jsonResponse({
          messages: [
            {
              type: 'text',
              content: `Swap confirmado, pero no puedo preparar la orden condicional: ${decision.reasons.join(', ')}`,
              execute: { status: 'success', tx_hash: request.tx_signature },
              timestamp: now(),
            },
          ],
        });
      }

      const conditionalToolArgs = {
        ...nextArgs,
        ...proposalPayload,
      };
      const proposal: AgentFunctionCallMessage = {
        type: 'function_call',
        function: {
          name: 'conditional_buy_sol',
          params: conditionalToolArgs,
        },
        display: {
          summary: `Orden condicional para ${proposalPayload.desired_sol_amount} SOL si SOL <= ${nextArgs.target_price_usd} USD`,
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

      updateSession(request.session_id, {
        pendingProposal: {
          proposalType: 'conditional_buy_sol',
          state: 'awaiting_approval',
          toolName: 'conditional_buy_sol',
          toolArgs: conditionalToolArgs,
          toolResult: {
            status: 'prepared',
            reason: 'READY_FOR_ONCHAIN_ORACLE_APPROVAL_AFTER_DEV_USDC_FUNDING',
            funding_swap_signature: request.tx_signature,
          },
          createdAt: Date.now(),
          expiresAt: getProposalExpiry(),
          expectedUserAddress: session.userAddress,
          network: DEFAULT_SOLANA_NETWORK,
          txSignature: request.tx_signature,
        },
      });

      return jsonResponse({
        messages: [
          {
            type: 'text',
            content: 'Swap de devUSDC confirmado. Ahora queda lista la orden condicional para aprobar con Phantom.',
            execute: { status: 'success', tx_hash: request.tx_signature },
            timestamp: now(),
          },
          proposal,
        ],
      });
    }
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
