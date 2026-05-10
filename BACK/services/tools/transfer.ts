/**
 * Transfer tool for chat agent.
 * Validates and prepares (but does NOT execute) wallet-to-wallet transfers.
 * Uses unified contract: { amount, token, recipient }
 */

import { tool } from '@langchain/core/tools';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

function isValidSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

// Unified transfer params matching frontend contract
export type TransferParams = {
  amount: number;
  token: string;
  recipient: string;
  memo?: string;
};

export type TransferPreparedAction = {
  type: 'TRANSFER';
  fromWallet: string;
  toWallet: string;
  amount: number;
  token: string;
  memo?: string;
  requiresUserSignature: boolean;
  executedOnChain: boolean;
};

export type TransferToolResult = {
  status: 'prepared' | 'denied';
  reason: string;
  preparedAction: TransferPreparedAction | null;
};

/**
 * Prepare a transfer action for user approval.
 * @param params - Transfer params from agent
 * @param fromWallet - User's wallet address from session
 */
export function prepareTransferResult(
  params: TransferParams,
  fromWallet: string
): TransferToolResult {
  const { amount, token, recipient, memo } = params;

  if (!fromWallet || !isValidSolanaAddress(fromWallet)) {
    return {
      status: 'denied',
      reason: 'INVALID_FROM_WALLET',
      preparedAction: null,
    };
  }

  if (!isValidSolanaAddress(recipient)) {
    return {
      status: 'denied',
      reason: 'INVALID_RECIPIENT',
      preparedAction: null,
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      status: 'denied',
      reason: 'INVALID_AMOUNT',
      preparedAction: null,
    };
  }

  return {
    status: 'prepared',
    reason: 'READY_FOR_USER_APPROVAL',
    preparedAction: {
      type: 'TRANSFER',
      fromWallet,
      toWallet: recipient,
      amount,
      token: token || 'SOL',
      memo,
      requiresUserSignature: true,
      executedOnChain: false,
    },
  };
}

/**
 * Generate display info for a transfer proposal
 */
export function generateTransferDisplay(params: TransferParams): {
  summary: string;
  fee_usd: number;
  provider: string;
} {
  const shortRecipient = `${params.recipient.slice(0, 4)}...${params.recipient.slice(-4)}`;
  return {
    summary: `Enviar ${params.amount} ${params.token || 'SOL'} a ${shortRecipient}`,
    fee_usd: 0.01, // TODO: Calculate real fee
    provider: 'Wallet Copilot',
  };
}

/**
 * Generate risk assessment for a transfer
 * TODO: Integrate with real risk scoring service
 */
export function assessTransferRisk(params: TransferParams): {
  score: number;
  level: 'low' | 'medium' | 'critical';
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 30; // Base score

  // Check amount thresholds
  if (params.amount > 10) {
    score += 30;
    reasons.push('Monto elevado');
  } else if (params.amount > 1) {
    score += 15;
    reasons.push('Monto moderado');
  }

  // New recipient (we'd check history in real implementation)
  score += 10;
  reasons.push('Verifica la dirección de destino');

  const level: 'low' | 'medium' | 'critical' =
    score >= 70 ? 'critical' : score >= 40 ? 'medium' : 'low';

  return { score: Math.min(score, 100), level, reasons };
}

/**
 * LangChain tool definition for transfer.
 * The agent calls this tool when user requests a transfer.
 * Note: fromWallet is NOT part of tool params - it comes from session.
 */
export const transferTool = tool(
  async (input: { amount: number; token?: string; recipient: string; memo?: string }): Promise<string> => {
    // This returns the params for the tool call
    // Actual preparation happens in chat.ts with user's wallet from session
    return JSON.stringify({
      toolName: 'transfer',
      params: {
        amount: input.amount,
        token: input.token || 'SOL',
        recipient: input.recipient,
        memo: input.memo,
      },
    });
  },
  {
    name: 'transfer',
    description:
      'Prepara una transferencia de SOL o tokens a otra wallet de Solana. ' +
      'NO ejecuta la transferencia on-chain. Retorna una acción preparada que requiere aprobación del usuario. ' +
      'Usa esta herramienta cuando el usuario quiera enviar/transferir SOL o tokens a otra dirección.',
    schema: z.object({
      amount: z.number().positive().describe('Cantidad a transferir'),
      token: z.string().optional().describe('Símbolo del token (default: SOL)'),
      recipient: z.string().describe('Dirección de destino (Solana public key)'),
      memo: z.string().optional().describe('Memo opcional para la transacción'),
    }) as any,
  }
);

export const allTools = [transferTool];
