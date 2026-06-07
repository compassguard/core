import { quoteOrcaUsdcToSol, type OrcaSwapParams } from './priceProviders/orcaUsdcSol';
import {
  getSolanaNetworkConfig,
  resolveSolanaNetwork,
  type SolanaNetwork,
} from './solanaNetworkConfig';

export type QuoteDirection = 'USDC->SOL' | 'SOL->USDC';

export type UsdcSolQuoteQuery = {
  network?: string;
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  slippage_bps?: number;
};

export type UsdcSolQuoteResult = {
  network: SolanaNetwork;
  provider: 'orca_whirlpools_devnet';
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  output_amount: number;
  input_mint: string;
  output_mint: string;
  slippage_bps: number;
  route_context?: string;
  quote_source: 'orca_whirlpool_quote' | 'fallback_sol_usd';
  updated_at: string;
};

export type QuoteErrorCode =
  | 'invalid_quote_payload'
  | 'unsupported_network'
  | 'invalid_pair'
  | 'invalid_amount'
  | 'invalid_network_config'
  | 'provider_timeout'
  | 'provider_error';

type QuoteError = Error & { code: QuoteErrorCode };

function createError(code: QuoteErrorCode, message: string): QuoteError {
  const error = new Error(message) as QuoteError;
  error.code = code;
  return error;
}

function toUiAmount(rawAmount: string, decimals: number): number {
  const normalized = Number(rawAmount);
  if (!Number.isFinite(normalized)) {
    throw createError('invalid_quote_payload', 'Invalid quote base amount');
  }
  return normalized / 10 ** decimals;
}

function parseParams(query: UsdcSolQuoteQuery): { network: SolanaNetwork; input: OrcaSwapParams } {
  const network = resolveSolanaNetwork(query.network);
  const inputToken = query.input_token?.toUpperCase() as UsdcSolQuoteQuery['input_token'];
  const outputToken = query.output_token?.toUpperCase() as UsdcSolQuoteQuery['output_token'];
  if (inputToken !== 'USDC' && inputToken !== 'SOL') {
    throw createError('invalid_quote_payload', 'Invalid input token');
  }
  if (outputToken !== 'USDC' && outputToken !== 'SOL') {
    throw createError('invalid_quote_payload', 'Invalid output token');
  }
  if (inputToken === outputToken) {
    throw createError('invalid_pair', 'Only USDC/SOL cross-pairs are supported');
  }
  if (!Number.isFinite(query.input_amount) || query.input_amount <= 0) {
    throw createError('invalid_amount', 'input_amount must be greater than zero');
  }

  return {
    network,
    input: {
      input_token: inputToken,
      output_token: outputToken,
      input_amount: query.input_amount,
      slippage_bps: query.slippage_bps,
      allow_fallback: true,
    },
  };
}

export async function getUsdcSolQuote(query: UsdcSolQuoteQuery): Promise<UsdcSolQuoteResult> {
  const { network, input } = parseParams(query);
  let networkConfig: ReturnType<typeof getSolanaNetworkConfig>;
  try {
    networkConfig = getSolanaNetworkConfig(network);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'invalid_network_config' || code === 'missing_network_config') {
      throw createError('invalid_network_config', error instanceof Error ? error.message : 'Invalid devnet mint configuration');
    }
    throw error;
  }

  let quote;
  try {
    quote = await quoteOrcaUsdcToSol(input);
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw createError('provider_timeout', 'Provider quote request timed out');
    }
    throw createError('provider_error', error instanceof Error ? error.message : 'Unable to fetch quote');
  }

  const isUsdcToSol = input.input_token === 'USDC';
  const outputDecimals = isUsdcToSol ? 9 : 6;
  const expectedInputMint = isUsdcToSol ? networkConfig.mints.USDC : networkConfig.mints.SOL;
  const expectedOutputMint = isUsdcToSol ? networkConfig.mints.SOL : networkConfig.mints.USDC;
  if (quote.input_mint !== expectedInputMint || quote.output_mint !== expectedOutputMint) {
    throw createError('invalid_network_config', 'Quote provider mints do not match configured devnet mints');
  }
  const outputAmount = toUiAmount(quote.estimated_output_base_units, outputDecimals);
  const slippageBps = Number.isFinite(input.slippage_bps) ? Number(input.slippage_bps) : quote.slippage_bps;

  return {
    network,
    provider: 'orca_whirlpools_devnet',
    input_token: input.input_token,
    output_token: input.output_token,
    input_amount: input.input_amount,
    output_amount: outputAmount,
    input_mint: quote.input_mint,
    output_mint: quote.output_mint,
    slippage_bps: slippageBps,
    route_context: 'orca_usdc_sol_devnet',
    quote_source: quote.quote_source,
    updated_at: new Date().toISOString(),
  };
}
