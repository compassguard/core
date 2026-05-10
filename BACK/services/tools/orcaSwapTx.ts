import { web3, BN } from '@coral-xyz/anchor';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { DEVNET_SOL_MINT, DEVNET_SOL_USDC_POOL, DEVNET_USDC_MINT } from './orcaSwap';
import { getConnection, getRpcUrl } from '../solanaConnection';

/**
 * Structured error info for guard rejections that can be bypassed.
 */
export type GuardRejectionError = {
  type: 'PRICE_DEVIATION_TOO_HIGH';
  canBypass: true;
  deviationBps: number;
  maxAllowedBps: number;
  message: string;
};

export type SimulationErrorResult = {
  isGuardRejection: boolean;
  guardRejection?: GuardRejectionError;
  errorMessage: string;
};

/**
 * Parse simulation error logs to provide structured error info.
 * Returns special structure for guard rejections that can be bypassed.
 */
function parseSimulationError(
  logs: string[],
  err: unknown,
  inputAmount: number,
  inputToken: string,
  maxDeviationBps?: number
): SimulationErrorResult {
  const logsText = logs.join('\n');
  
  // Check for PriceDeviationTooHigh - this is bypassable
  if (logsText.includes('PriceDeviationTooHigh')) {
    console.log('[orcaSwapTx] Detected PriceDeviationTooHigh - guard rejection is bypassable');
    return {
      isGuardRejection: true,
      guardRejection: {
        type: 'PRICE_DEVIATION_TOO_HIGH',
        canBypass: true,
        deviationBps: 0, // Will be calculated by caller with actual values
        maxAllowedBps: maxDeviationBps || 500,
        message: 'El precio del swap difiere significativamente del precio de mercado (oráculo). Ejecutar sin protección podría resultar en pérdidas.',
      },
      errorMessage: 'PRICE_GUARD_REJECTED: El guard on-chain rechazó la transacción por desviación de precio.',
    };
  }
  
  // Check for insufficient funds error - NOT bypassable
  const insufficientMatch = logsText.match(/Transfer: insufficient lamports (\d+), need (\d+)/);
  if (insufficientMatch) {
    const available = Number(insufficientMatch[1]) / 1e9;
    const needed = Number(insufficientMatch[2]) / 1e9;
    return {
      isGuardRejection: false,
      errorMessage: `INSUFFICIENT_FUNDS: Tu wallet tiene ${available.toFixed(4)} SOL pero el swap necesita ${needed.toFixed(4)} SOL (incluyendo fees). Reduce el monto o agrega fondos.`,
    };
  }
  
  // Check for insufficient token balance - NOT bypassable
  if (logsText.includes('insufficient funds') || logsText.includes('Insufficient')) {
    return {
      isGuardRejection: false,
      errorMessage: `INSUFFICIENT_FUNDS: No tenés suficiente ${inputToken} para este swap de ${inputAmount} ${inputToken}.`,
    };
  }
  
  // Check for other oracle/guard errors - NOT bypassable
  if (logsText.includes('OracleDataStale')) {
    return {
      isGuardRejection: false,
      errorMessage: 'ORACLE_STALE: Los datos del oráculo de precio están desactualizados. Intentá de nuevo en unos segundos.',
    };
  }
  
  if (logsText.includes('OracleConfidenceTooHigh')) {
    return {
      isGuardRejection: false,
      errorMessage: 'ORACLE_UNCERTAIN: El oráculo de precio tiene baja confianza. Esperá a que el mercado se estabilice.',
    };
  }
  
  // Check for slippage errors - NOT bypassable
  if (logsText.includes('slippage') || logsText.includes('AmountOutBelowMinimum')) {
    return {
      isGuardRejection: false,
      errorMessage: 'SLIPPAGE_EXCEEDED: El precio cambió más de lo permitido. Aumentá el slippage o intentá con un monto menor.',
    };
  }
  
  // Generic error - NOT bypassable
  const errStr = typeof err === 'object' ? JSON.stringify(err) : String(err);
  return {
    isGuardRejection: false,
    errorMessage: `SWAP_FAILED: La transacción no se pudo completar. Error: ${errStr}`,
  };
}

type WalletStub = {
  publicKey: web3.PublicKey;
  signTransaction: <T extends web3.Transaction | web3.VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends web3.Transaction | web3.VersionedTransaction>(txs: T[]) => Promise<T[]>;
};

export type OrcaSwapTxResult = {
  unsignedTxBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  isVersioned: boolean;
  estimatedOutputBaseUnits: string;
  minOutputBaseUnits: string;
};

export type OrcaSwapTxWithGuardResult = 
  | { success: true; tx: OrcaSwapTxResult }
  | { success: false; guardRejection: GuardRejectionError; quotedPriceUsd: number; oraclePriceUsd: number }
  | { success: false; error: string };

export async function buildUnsignedOrcaSwapTx(params: {
  userAddress: string;
  inputToken: 'USDC' | 'SOL';
  outputToken: 'USDC' | 'SOL';
  inputAmount: number;
  slippageBps?: number;
}): Promise<OrcaSwapTxResult> {
  const supportedPair =
    (params.inputToken === 'USDC' && params.outputToken === 'SOL') ||
    (params.inputToken === 'SOL' && params.outputToken === 'USDC');
  if (!supportedPair) {
    throw new Error('unsupported_swap_pair');
  }
  const connection = getConnection();
  const userPubkey = new web3.PublicKey(params.userAddress);
  const slippageBps = params.slippageBps ?? 100;

  const walletStub: WalletStub = {
    publicKey: userPubkey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };

  const ctx = WhirlpoolContext.from(connection, walletStub as any);
  const client = buildWhirlpoolClient(ctx);

  const poolPubkey = new web3.PublicKey(DEVNET_SOL_USDC_POOL);
  const whirlpool = await client.getPool(poolPubkey);

  const inputIsUsdc = params.inputToken === 'USDC';
  const inputAmount = new BN(
    Math.round(params.inputAmount * (inputIsUsdc ? 1_000_000 : 1_000_000_000))
  );
  const slippage = Percentage.fromFraction(slippageBps, 10_000);

  const quote = await swapQuoteByInputToken(
    whirlpool,
    new web3.PublicKey(inputIsUsdc ? DEVNET_USDC_MINT : DEVNET_SOL_MINT),
    inputAmount,
    slippage,
    ctx.program.programId,
    ctx.fetcher,
    IGNORE_CACHE
  );

  // Build the swap transaction
  const txBuilder = await whirlpool.swap(quote, userPubkey);
  
  // Get fresh blockhash right before building
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  
  // Build with the fresh blockhash
  const txPayload = await txBuilder.build({ latestBlockhash: { blockhash, lastValidBlockHeight } });
  const tx = txPayload.transaction;
  const extraSigners = txPayload.signers.filter((signer): signer is web3.Signer => signer !== undefined);

  // Orca may require additional non-wallet signers (for example wrapped SOL flows).
  // Apply those signatures server-side before handing the transaction to Phantom.
  const isVersioned = tx instanceof web3.VersionedTransaction;
  let serialized: Uint8Array;
  
  if (isVersioned) {
    if (extraSigners.length > 0) {
      tx.sign(extraSigners);
    }
    serialized = tx.serialize();
  } else {
    tx.feePayer = userPubkey;
    tx.recentBlockhash = blockhash;
    extraSigners.forEach((signer) => tx.partialSign(signer));
    serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  }

  const base64Tx = Buffer.from(serialized).toString('base64');

  return {
    unsignedTxBase64: base64Tx,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    isVersioned,
    estimatedOutputBaseUnits: quote.estimatedAmountOut.toString(),
    minOutputBaseUnits: quote.otherAmountThreshold.toString(),
  };
}

/**
 * Build an Orca swap transaction with guard instructions prepended.
 * 
 * The transaction will be structured as:
 * 1. [Optional] initialize_policy - if user has no policy yet
 * 2. create_action_approval - create approval for this swap
 * 3. mark_executed_if_swap_price_within_band - validate price against oracle
 * 4. Orca swap instructions
 * 
 * If any instruction fails, the entire transaction fails atomically.
 * 
 * Returns structured result instead of throwing, so caller can handle guard rejections.
 */
export async function buildUnsignedOrcaSwapTxWithGuard(params: {
  userAddress: string;
  inputToken: 'USDC' | 'SOL';
  outputToken: 'USDC' | 'SOL';
  inputAmount: number;
  slippageBps?: number;
  guardInstructions: web3.TransactionInstruction[];
  quotedPriceUsd?: number;
  oraclePriceUsd?: number;
  maxDeviationBps?: number;
}): Promise<OrcaSwapTxWithGuardResult> {
  const supportedPair =
    (params.inputToken === 'USDC' && params.outputToken === 'SOL') ||
    (params.inputToken === 'SOL' && params.outputToken === 'USDC');
  if (!supportedPair) {
    return { success: false, error: 'unsupported_swap_pair' };
  }
  
  const connection = getConnection();
  const userPubkey = new web3.PublicKey(params.userAddress);
  const slippageBps = params.slippageBps ?? 100;

  const walletStub: WalletStub = {
    publicKey: userPubkey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };

  const ctx = WhirlpoolContext.from(connection, walletStub as any);
  const client = buildWhirlpoolClient(ctx);

  const poolPubkey = new web3.PublicKey(DEVNET_SOL_USDC_POOL);
  const whirlpool = await client.getPool(poolPubkey);

  const inputIsUsdc = params.inputToken === 'USDC';
  const inputAmount = new BN(
    Math.round(params.inputAmount * (inputIsUsdc ? 1_000_000 : 1_000_000_000))
  );
  const slippage = Percentage.fromFraction(slippageBps, 10_000);

  const quote = await swapQuoteByInputToken(
    whirlpool,
    new web3.PublicKey(inputIsUsdc ? DEVNET_USDC_MINT : DEVNET_SOL_MINT),
    inputAmount,
    slippage,
    ctx.program.programId,
    ctx.fetcher,
    IGNORE_CACHE
  );

  // Build the swap transaction
  const txBuilder = await whirlpool.swap(quote, userPubkey);
  
  // Get fresh blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  
  // Build swap payload
  const txPayload = await txBuilder.build({ latestBlockhash: { blockhash, lastValidBlockHeight } });
  const swapTx = txPayload.transaction;
  const extraSigners = txPayload.signers.filter((signer): signer is web3.Signer => signer !== undefined);

  // Extract swap instructions from the Orca transaction
  let swapInstructions: web3.TransactionInstruction[];
  
  if (swapTx instanceof web3.VersionedTransaction) {
    // For versioned transactions, we need to decompile to get instructions
    // This is more complex - we'll build a legacy transaction instead
    // by recreating the swap with legacy transaction
    const legacyTx = new web3.Transaction();
    legacyTx.recentBlockhash = blockhash;
    legacyTx.feePayer = userPubkey;
    
    // Get instructions from the message
    const message = swapTx.message;
    const accountKeys = message.staticAccountKeys;
    
    for (let i = 0; i < message.compiledInstructions.length; i++) {
      const compiledIx = message.compiledInstructions[i];
      const programId = accountKeys[compiledIx.programIdIndex];
      const keys = compiledIx.accountKeyIndexes.map((idx) => ({
        pubkey: accountKeys[idx],
        isSigner: message.isAccountSigner(idx),
        isWritable: message.isAccountWritable(idx),
      }));
      
      legacyTx.add(new web3.TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(compiledIx.data),
      }));
    }
    
    swapInstructions = legacyTx.instructions;
  } else {
    swapInstructions = swapTx.instructions;
  }

  // Build combined transaction: guard instructions + swap instructions
  // Collect all instructions
  const allInstructions: web3.TransactionInstruction[] = [];
  
  // Add guard instructions first
  for (const ix of params.guardInstructions) {
    allInstructions.push(ix);
  }
  
  // Add swap instructions
  for (const ix of swapInstructions) {
    allInstructions.push(ix);
  }

  console.log(`[orcaSwapTx] Building combined tx with ${allInstructions.length} instructions`);
  
  // Log each instruction for debugging
  allInstructions.forEach((ix, i) => {
    console.log(`[orcaSwapTx] Instruction ${i}: programId=${ix.programId.toBase58()}, keys=${ix.keys.length}, data=${ix.data.length} bytes`);
  });

  // Build as VersionedTransaction for better Phantom compatibility
  const messageV0 = new web3.TransactionMessage({
    payerKey: userPubkey,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message();

  const versionedTx = new web3.VersionedTransaction(messageV0);
  
  console.log(`[orcaSwapTx] VersionedTransaction created with ${versionedTx.message.compiledInstructions.length} compiled instructions`);

  // Apply extra signers from Orca (e.g., for wrapped SOL)
  if (extraSigners.length > 0) {
    versionedTx.sign(extraSigners);
  }

  // Simulate the transaction to catch errors early
  console.log('[orcaSwapTx] Simulating transaction...');
  const simulation = await connection.simulateTransaction(versionedTx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  
  if (simulation.value.err) {
    console.error('[orcaSwapTx] Simulation failed:', JSON.stringify(simulation.value.err));
    console.error('[orcaSwapTx] Simulation logs:', simulation.value.logs);
    
    // Parse simulation logs to get structured error info
    const logs = simulation.value.logs || [];
    const errorResult = parseSimulationError(
      logs, 
      simulation.value.err, 
      params.inputAmount, 
      params.inputToken,
      params.maxDeviationBps
    );
    
    // If it's a guard rejection (PriceDeviationTooHigh), return structured info for bypass
    if (errorResult.isGuardRejection && errorResult.guardRejection) {
      console.log('[orcaSwapTx] Guard rejection detected - returning bypassable error');
      console.log(`[orcaSwapTx] quotedPriceUsd=${params.quotedPriceUsd}, oraclePriceUsd=${params.oraclePriceUsd}`);
      
      // Calculate actual deviation if we have both prices
      if (params.quotedPriceUsd && params.oraclePriceUsd && params.oraclePriceUsd > 0) {
        const deviation = Math.abs(params.quotedPriceUsd - params.oraclePriceUsd) / params.oraclePriceUsd;
        errorResult.guardRejection.deviationBps = Math.round(deviation * 10000);
        console.log(`[orcaSwapTx] Calculated deviation: ${errorResult.guardRejection.deviationBps} bps`);
      }
      
      return {
        success: false,
        guardRejection: errorResult.guardRejection,
        quotedPriceUsd: params.quotedPriceUsd || 0,
        oraclePriceUsd: params.oraclePriceUsd || 0,
      };
    }
    
    // Non-bypassable error
    console.log('[orcaSwapTx] Non-bypassable error:', errorResult.errorMessage);
    return { success: false, error: errorResult.errorMessage };
  }
  
  console.log('[orcaSwapTx] Simulation successful, units consumed:', simulation.value.unitsConsumed);
  
  const serialized = versionedTx.serialize();
  const base64Tx = Buffer.from(serialized).toString('base64');

  return {
    success: true,
    tx: {
      unsignedTxBase64: base64Tx,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      isVersioned: true,
      estimatedOutputBaseUnits: quote.estimatedAmountOut.toString(),
      minOutputBaseUnits: quote.otherAmountThreshold.toString(),
    },
  };
}
