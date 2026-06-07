/**
 * Swap Guard - Oracle price validation helper
 * 
 * Fetches Pyth oracle price and computes deviation against quoted swap price.
 * Used to populate swap_guard metadata in function_approve response.
 */

import { PublicKey } from '@solana/web3.js';
import { getConnection, getCachedOrFetch } from '../solanaConnection';

// Pyth SOL/USD price account on devnet (NOT the feed ID!)
// The feed ID (ef0d8b...) is different from the price account address
const PYTH_SOL_USD_PRICE_ACCOUNT_DEVNET = process.env.PYTH_SOL_USD_PRICE_ACCOUNT || 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix';

// Guard thresholds (configurable via env)
const WARNING_DEVIATION_BPS = Number(process.env.SWAP_GUARD_WARNING_DEVIATION_BPS || '150'); // 1.5%
const MAX_DEVIATION_BPS = Number(process.env.SWAP_GUARD_MAX_DEVIATION_BPS || '500'); // 5%
// High staleness for devnet (legacy Pyth accounts aren't updated frequently)
// For mainnet with Pyth Pull, use 60
const STALENESS_SECONDS = Number(process.env.SWAP_GUARD_STALENESS_SECONDS || '86400');
const MAX_CONFIDENCE_BPS = Number(process.env.SWAP_GUARD_MAX_CONFIDENCE_BPS || '100'); // 1%

// Pyth account layout constants
const PYTH_PRICE_ACCOUNT_SIZE = 3312;
const PYTH_MAGIC = 0xa1b2c3d4;
const PYTH_VERSION = 2;
const PYTH_PRICE_TYPE = 3;
const TARGET_EXPONENT = -8;

export type SwapGuardConfig = {
  program_id: string;
  oracle_feed: string;
  quoted_price_usd_e8: number;
  oracle_price_usd_e8?: number;
  deviation_bps?: number;
  warning_deviation_bps: number;
  max_deviation_bps: number;
  staleness_seconds: number;
  max_confidence_bps: number;
  network: 'devnet' | 'mainnet-beta';
  on_chain_enforcement?: boolean;
  action_approval_pda?: string;
};

export type SwapGuardWarning = {
  code: 'price_deviation_warning';
  message: string;
  deviation_bps: number;
} | null;

export type SwapGuardResult = {
  config: SwapGuardConfig;
  warning: SwapGuardWarning;
  blocked: boolean;
  block_reason?: string;
};

function readPythPrice(data: Buffer): { price_e8: number; confidence: number; timestamp: number } | null {
  if (data.length < PYTH_PRICE_ACCOUNT_SIZE) return null;

  const magic = data.readUInt32LE(0);
  if (magic !== PYTH_MAGIC) return null;

  const version = data.readUInt32LE(4);
  if (version !== PYTH_VERSION) return null;

  const atype = data.readUInt32LE(8);
  if (atype !== PYTH_PRICE_TYPE) return null;

  const expo = data.readInt32LE(20);
  const price = data.readBigInt64LE(208);
  const conf = data.readBigUInt64LE(216);
  const status = data.readUInt32LE(224);
  const timestamp = data.readBigInt64LE(296);

  // Status 1 = Trading
  if (status !== 1) return null;

  // Convert to e8
  let price_e8: number;
  if (expo === TARGET_EXPONENT) {
    price_e8 = Number(price);
  } else if (expo < TARGET_EXPONENT) {
    const shift = TARGET_EXPONENT - expo;
    price_e8 = Number(price) / Math.pow(10, shift);
  } else {
    const shift = expo - TARGET_EXPONENT;
    price_e8 = Number(price) * Math.pow(10, shift);
  }

  return {
    price_e8: Math.round(price_e8),
    confidence: Number(conf),
    timestamp: Number(timestamp),
  };
}

/**
 * Computes deviation in basis points between quoted and oracle price.
 */
function computeDeviationBps(quotedPriceE8: number, oraclePriceE8: number): number {
  if (oraclePriceE8 <= 0) return 10000; // 100% deviation if invalid
  const diff = Math.abs(quotedPriceE8 - oraclePriceE8);
  return Math.round((diff * 10000) / oraclePriceE8);
}

/**
 * Fetches Pyth oracle price and builds swap guard config with deviation check.
 * 
 * @param quotedPriceUsd - The implied USD price from the swap quote
 * @param inputToken - 'SOL' or 'USDC'
 * @param outputToken - 'SOL' or 'USDC'
 */
export async function buildSwapGuardConfig(
  quotedPriceUsd: number,
  _inputToken: 'SOL' | 'USDC',
  _outputToken: 'SOL' | 'USDC'
): Promise<SwapGuardResult> {
  void _inputToken;
  void _outputToken;

  const programId = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) {
    return {
      config: {
        program_id: '',
        oracle_feed: '',
        quoted_price_usd_e8: 0,
        warning_deviation_bps: WARNING_DEVIATION_BPS,
        max_deviation_bps: MAX_DEVIATION_BPS,
        staleness_seconds: STALENESS_SECONDS,
        max_confidence_bps: MAX_CONFIDENCE_BPS,
        network: 'devnet',
      },
      warning: null,
      blocked: true,
      block_reason: 'AGENT_ACTION_GUARD_PROGRAM_ID not configured',
    };
  }

  // For SOL/USDC swaps, we use SOL/USD oracle price account
  const oracleFeedPubkey = new PublicKey(PYTH_SOL_USD_PRICE_ACCOUNT_DEVNET);

  // Convert quoted price to e8 format
  const quotedPriceE8 = Math.round(quotedPriceUsd * 1e8);

  const config: SwapGuardConfig = {
    program_id: programId,
    oracle_feed: oracleFeedPubkey.toBase58(),
    quoted_price_usd_e8: quotedPriceE8,
    warning_deviation_bps: WARNING_DEVIATION_BPS,
    max_deviation_bps: MAX_DEVIATION_BPS,
    staleness_seconds: STALENESS_SECONDS,
    max_confidence_bps: MAX_CONFIDENCE_BPS,
    network: 'devnet',
  };

  try {
    const conn = getConnection();
    // Cache oracle price for 2 seconds to reduce RPC calls
    const accountInfo = await getCachedOrFetch(
      `pyth_oracle_${oracleFeedPubkey.toBase58()}`,
      () => conn.getAccountInfo(oracleFeedPubkey),
      2000
    );
    
    if (!accountInfo || !accountInfo.data) {
      return {
        config,
        warning: null,
        blocked: true,
        block_reason: 'Oracle feed account not found',
      };
    }

    const pythData = readPythPrice(accountInfo.data as Buffer);
    if (!pythData) {
      return {
        config,
        warning: null,
        blocked: true,
        block_reason: 'Invalid Pyth oracle data',
      };
    }

    // Check staleness
    const now = Math.floor(Date.now() / 1000);
    const age = now - pythData.timestamp;
    if (age > STALENESS_SECONDS) {
      return {
        config: { ...config, oracle_price_usd_e8: pythData.price_e8 },
        warning: null,
        blocked: true,
        block_reason: `Oracle data stale (${age}s > ${STALENESS_SECONDS}s)`,
      };
    }

    // Check confidence
    const confBps = Math.round((pythData.confidence * 10000) / Math.abs(pythData.price_e8));
    if (confBps > MAX_CONFIDENCE_BPS) {
      return {
        config: { ...config, oracle_price_usd_e8: pythData.price_e8 },
        warning: null,
        blocked: true,
        block_reason: `Oracle confidence too high (${confBps}bps > ${MAX_CONFIDENCE_BPS}bps)`,
      };
    }

    // Compute deviation
    const deviationBps = computeDeviationBps(quotedPriceE8, pythData.price_e8);
    config.oracle_price_usd_e8 = pythData.price_e8;
    config.deviation_bps = deviationBps;

    // Check critical band (block)
    if (deviationBps > MAX_DEVIATION_BPS) {
      return {
        config,
        warning: null,
        blocked: true,
        block_reason: `Price deviation too high (${deviationBps}bps > ${MAX_DEVIATION_BPS}bps)`,
      };
    }

    // Check warning band
    let warning: SwapGuardWarning = null;
    if (deviationBps > WARNING_DEVIATION_BPS) {
      warning = {
        code: 'price_deviation_warning',
        message: `El precio cotizado difiere ${(deviationBps / 100).toFixed(1)}% del precio de mercado. No es ideal, pero puedes continuar.`,
        deviation_bps: deviationBps,
      };
    }

    return {
      config,
      warning,
      blocked: false,
    };
  } catch (error) {
    console.error('[swapGuard] Error fetching oracle:', error);
    return {
      config,
      warning: null,
      blocked: true,
      block_reason: `Oracle fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/**
 * Computes the implied SOL/USD price from a swap quote.
 */
export function computeImpliedPrice(
  inputToken: 'SOL' | 'USDC',
  outputToken: 'SOL' | 'USDC',
  inputAmount: number,
  estimatedOutputAmount: number
): number {
  // For SOL -> USDC: price = output_usdc / input_sol
  // For USDC -> SOL: price = input_usdc / output_sol
  if (inputToken === 'SOL' && outputToken === 'USDC') {
    return estimatedOutputAmount / inputAmount;
  } else if (inputToken === 'USDC' && outputToken === 'SOL') {
    return inputAmount / estimatedOutputAmount;
  }
  return 0;
}
