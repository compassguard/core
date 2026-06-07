import { web3, BN } from '@coral-xyz/anchor';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { getConnection } from '../solanaConnection';

export const DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
export const DEVNET_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEVNET_SOL_USDC_POOL = '3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt';

export type OrcaSwapParams = {
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  slippage_bps?: number;
  allow_fallback?: boolean;
};

export type QuoteSource = 'orca_whirlpool_quote' | 'fallback_sol_usd';

export type OrcaSwapQuote = {
  input_amount_base_units: string;
  estimated_output_base_units: string;
  min_output_base_units: string;
  trade_fee_base_units: string;
  slippage_bps: number;
  pool_address: string;
  input_mint: string;
  output_mint: string;
  quote_source: QuoteSource;
};

type WalletStub = {
  publicKey: web3.PublicKey;
  signTransaction: <T extends web3.Transaction | web3.VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends web3.Transaction | web3.VersionedTransaction>(txs: T[]) => Promise<T[]>;
};

function tokenScale(token: 'USDC' | 'SOL'): number {
  return token === 'USDC' ? 1_000_000 : 1_000_000_000;
}

function fallbackQuote(params: OrcaSwapParams, slippageBps: number): OrcaSwapQuote {
  const isUsdcToSol = params.input_token === 'USDC';
  const solPrice = Number(process.env.FALLBACK_SOL_USD_PRICE || '140');
  if (!Number.isFinite(solPrice) || solPrice <= 0) {
    throw new Error('orca_quote_failed:invalid_fallback_sol_usd_price');
  }

  const inputAmountBaseUnits = BigInt(Math.round(params.input_amount * tokenScale(params.input_token)));
  const grossOut = isUsdcToSol ? params.input_amount / solPrice : params.input_amount * solPrice;
  const minOut = grossOut * (1 - slippageBps / 10_000);
  const estOutBaseUnits = BigInt(Math.round(grossOut * tokenScale(params.output_token)));
  const minOutBaseUnits = BigInt(Math.round(minOut * tokenScale(params.output_token)));
  const feeBaseUnits = inputAmountBaseUnits / BigInt(1000);

  return {
    input_amount_base_units: inputAmountBaseUnits.toString(),
    estimated_output_base_units: estOutBaseUnits.toString(),
    min_output_base_units: minOutBaseUnits.toString(),
    trade_fee_base_units: feeBaseUnits.toString(),
    slippage_bps: slippageBps,
    pool_address: DEVNET_SOL_USDC_POOL,
    input_mint: isUsdcToSol ? DEVNET_USDC_MINT : DEVNET_SOL_MINT,
    output_mint: isUsdcToSol ? DEVNET_SOL_MINT : DEVNET_USDC_MINT,
    quote_source: 'fallback_sol_usd',
  };
}

async function quoteFromWhirlpool(params: OrcaSwapParams, slippageBps: number): Promise<OrcaSwapQuote> {
  const connection = getConnection();
  const walletStub: WalletStub = {
    publicKey: web3.SystemProgram.programId,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };

  const ctx = WhirlpoolContext.from(connection, walletStub as unknown as Parameters<typeof WhirlpoolContext.from>[1]);
  const client = buildWhirlpoolClient(ctx);
  const whirlpool = await client.getPool(new web3.PublicKey(DEVNET_SOL_USDC_POOL));
  const inputIsUsdc = params.input_token === 'USDC';
  const inputAmount = new BN(Math.round(params.input_amount * tokenScale(params.input_token)));
  const slippage = Percentage.fromFraction(slippageBps, 10_000);
  const quote = await swapQuoteByInputToken(
    whirlpool,
    new web3.PublicKey(inputIsUsdc ? DEVNET_USDC_MINT : DEVNET_SOL_MINT),
    inputAmount,
    slippage,
    ctx.program.programId,
    ctx.fetcher,
    IGNORE_CACHE,
  );
  const feeAmount = (BigInt(inputAmount.toString()) / BigInt(1000)).toString();

  return {
    input_amount_base_units: inputAmount.toString(),
    estimated_output_base_units: quote.estimatedAmountOut.toString(),
    min_output_base_units: quote.otherAmountThreshold.toString(),
    trade_fee_base_units: feeAmount,
    slippage_bps: slippageBps,
    pool_address: DEVNET_SOL_USDC_POOL,
    input_mint: inputIsUsdc ? DEVNET_USDC_MINT : DEVNET_SOL_MINT,
    output_mint: inputIsUsdc ? DEVNET_SOL_MINT : DEVNET_USDC_MINT,
    quote_source: 'orca_whirlpool_quote',
  };
}

export async function quoteOrcaUsdcToSol(params: OrcaSwapParams): Promise<OrcaSwapQuote> {
  const supportedPair =
    (params.input_token === 'USDC' && params.output_token === 'SOL') ||
    (params.input_token === 'SOL' && params.output_token === 'USDC');
  if (!supportedPair) {
    throw new Error('unsupported_swap_pair');
  }
  if (!Number.isFinite(params.input_amount) || params.input_amount <= 0) {
    throw new Error('invalid_swap_amount');
  }

  const slippageBps = params.slippage_bps ?? 100;

  try {
    return await quoteFromWhirlpool(params, slippageBps);
  } catch (e) {
    if (params.allow_fallback === false) {
      throw new Error(`orca_quote_failed:${e instanceof Error ? e.message : 'unknown'}`);
    }
    return fallbackQuote(params, slippageBps);
  }
}
