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

export type OrcaSwapQuote = {
  input_amount_base_units: string;
  estimated_output_base_units: string;
  min_output_base_units: string;
  trade_fee_base_units: string;
  slippage_bps: number;
  pool_address: string;
  input_mint: string;
  output_mint: string;
};

type OrcaTokenResponse = { data?: { priceUsdc?: number } };

async function fetchTokenPriceUsdc(baseUrl: string, mint: string): Promise<number> {
  const res = await fetch(`${baseUrl}/tokens/${mint}`);
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '<no-body>';
    }
    throw new Error(`orca_token_http_${res.status}:${mint}:${body.slice(0, 180)}`);
  }

  const json = (await res.json()) as OrcaTokenResponse;
  const price = Number(json?.data?.priceUsdc);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`orca_token_invalid_price:${mint}`);
  }

  return price;
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

  // Quote source: Orca public API token prices (devnet)
  const baseUrl = 'https://api.orca.so/v2/solana';
  let usdcPrice = 1;
  let solPrice = 0;
  try {
    [usdcPrice, solPrice] = await Promise.all([
      fetchTokenPriceUsdc(baseUrl, DEVNET_USDC_MINT),
      fetchTokenPriceUsdc(baseUrl, DEVNET_SOL_MINT),
    ]);
  } catch (e) {
    if (params.allow_fallback === false) {
      throw new Error(`orca_quote_failed:${e instanceof Error ? e.message : 'unknown'}`);
    }
    // Fallback hardcoded devnet quote baseline to avoid breaking UX when API is flaky.
    // This only affects proposal estimate; final execution still uses on-chain tx building/signing.
    usdcPrice = 1;
    solPrice = Number(process.env.FALLBACK_SOL_USD_PRICE || '140');
    if (!Number.isFinite(solPrice) || solPrice <= 0) {
      throw new Error(`orca_quote_failed:${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  const isUsdcToSol = params.input_token === 'USDC';
  const inputAmountBaseUnits = BigInt(
    Math.round(params.input_amount * (isUsdcToSol ? 1_000_000 : 1_000_000_000))
  );

  const grossOut = isUsdcToSol
    ? (params.input_amount * usdcPrice) / solPrice
    : (params.input_amount * solPrice) / usdcPrice;
  const minOut = grossOut * (1 - slippageBps / 10_000);
  const estOutBaseUnits = BigInt(
    Math.round(grossOut * (isUsdcToSol ? 1_000_000_000 : 1_000_000))
  );
  const minOutBaseUnits = BigInt(
    Math.round(minOut * (isUsdcToSol ? 1_000_000_000 : 1_000_000))
  );
  const feeBaseUnits = inputAmountBaseUnits / BigInt(1000); // placeholder 0.1% indicative

  return {
    input_amount_base_units: inputAmountBaseUnits.toString(),
    estimated_output_base_units: estOutBaseUnits.toString(),
    min_output_base_units: minOutBaseUnits.toString(),
    trade_fee_base_units: feeBaseUnits.toString(),
    slippage_bps: slippageBps,
    pool_address: DEVNET_SOL_USDC_POOL,
    input_mint: isUsdcToSol ? DEVNET_USDC_MINT : DEVNET_SOL_MINT,
    output_mint: isUsdcToSol ? DEVNET_SOL_MINT : DEVNET_USDC_MINT,
  };
}
