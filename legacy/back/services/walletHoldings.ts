import { validateWalletAddress } from './transactionHistory';
import {
  getSolanaNetworkConfig,
  getTokenProgramId,
  getMintForNetwork,
  resolveSolanaNetwork,
  type SolanaNetwork,
} from './solanaNetworkConfig';

const RPC_TIMEOUT_MS = 10_000;

type RpcResponse = {
  jsonrpc?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

type RpcBalanceResult = RpcResponse & {
  result: { value: number };
};

type RpcTokenAccountParsed = {
  account: {
    data?: {
      parsed?: {
        info?: {
          mint?: unknown;
          tokenAmount?: {
            amount?: unknown;
            decimals?: unknown;
            uiAmount?: unknown;
          };
        };
      };
    };
  };
  pubkey?: unknown;
};

type RpcTokenAccountsResult = RpcResponse & {
  result?: {
    value?: unknown;
  };
};

export type WalletHoldingsTokenBalance = {
  symbol: string;
  mint: string;
  amount: string;
  decimals: number;
  ui_amount: number;
  usd_value: number;
  icon_url?: string;
};

export type WalletHoldingsResponse = {
  network: SolanaNetwork;
  balances: WalletHoldingsTokenBalance[];
  total_usd: number;
  updated_at: string;
  partial?: boolean;
  warnings?: Array<{
    code: 'spl_holdings_unavailable';
    message: string;
  }>;
};

export type WalletHoldingsQuery = {
  address: string;
  network?: string;
};

export type WalletHoldingsErrorCode =
  | 'invalid_address'
  | 'unsupported_network'
  | 'invalid_mint_config'
  | 'provider_timeout'
  | 'provider_error'
  | 'provider_parse_error';

type WalletHoldingsError = Error & { code: WalletHoldingsErrorCode };

function createError(code: WalletHoldingsErrorCode, message: string): WalletHoldingsError {
  const error = new Error(message) as WalletHoldingsError;
  error.code = code;
  return error;
}

function getStableErrorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

function isNetworkConfigError(error: unknown): boolean {
  const code = getStableErrorCode(error);
  return code === 'invalid_network_config' || code === 'missing_network_config' || code === 'invalid_mint_config';
}

type TimeoutOperation<T> = (signal: AbortSignal) => Promise<T>;

function withTimeout<T>(operation: TimeoutOperation<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  return operation(controller.signal)
    .finally(() => clearTimeout(timeout))
    .catch((error) => {
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw createError('provider_timeout', 'Provider request timed out');
      }
      throw error;
    });
}

function parseSolBalance(raw: RpcResponse): number {
  const parsed = raw as RpcBalanceResult;
  if (parsed.error) {
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'Provider RPC error';
    throw createError('provider_error', message);
  }
  const value = parsed.result?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createError('provider_parse_error', 'Invalid SOL balance payload');
  }
  return value;
}

function parseTokenAmount(amount: unknown): { base: string; ui: number; decimals: number } | null {
  if (!amount || typeof amount !== 'object') return null;
  const parsed = amount as {
    amount?: unknown;
    decimals?: unknown;
    uiAmount?: unknown;
  };

  const rawAmount = typeof parsed.amount === 'string' || typeof parsed.amount === 'number' ? String(parsed.amount) : undefined;
  const decimals = Number(parsed.decimals);
  if (!rawAmount || Number.isNaN(decimals) || !Number.isFinite(decimals) || decimals < 0 || !Number.isInteger(decimals)) {
    return null;
  }

  const uiAmountFromPayload = parsed.uiAmount;
  let uiAmount = typeof uiAmountFromPayload === 'number' ? uiAmountFromPayload : Number.NaN;
  if (!Number.isFinite(uiAmount)) {
    const normalized = Number(rawAmount);
    if (!Number.isFinite(normalized)) {
      return null;
    }
    uiAmount = normalized / 10 ** decimals;
  }

  if (!Number.isFinite(uiAmount) || uiAmount < 0) {
    return null;
  }
  return { base: rawAmount, ui: uiAmount, decimals };
}

function normalizeTokenAccount(raw: RpcTokenAccountParsed, network: SolanaNetwork, tokenMints: { SOL: string; USDC: string }): WalletHoldingsTokenBalance | null {
  if (!raw?.account?.data?.parsed?.info) return null;
  const info = raw.account.data.parsed.info as Record<string, unknown>;
  const mint = typeof info.mint === 'string' ? info.mint.trim() : '';
  if (!mint) return null;
  const tokenAmount = parseTokenAmount(info.tokenAmount);
  if (!tokenAmount) return null;
  if (tokenAmount.ui <= 0) return null;
  const isSolMint = mint === tokenMints.SOL;

  return {
    symbol: isSolMint ? 'WSOL' : mint === tokenMints.USDC ? 'USDC' : `UNKNOWN(${mint.slice(0, 4)})`,
    mint,
    amount: tokenAmount.base,
    decimals: tokenAmount.decimals,
    ui_amount: tokenAmount.ui,
    usd_value: isSolMint ? 0 : 0,
  };
}

async function fetchRpc(payload: unknown, rpcUrl: string): Promise<unknown> {
  const response = await withTimeout((signal) =>
    fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  );

  if (!(response instanceof Response)) {
    throw createError('provider_error', 'Invalid provider response');
  }
  if (!response.ok) {
    throw createError('provider_error', `Provider RPC failed with status ${response.status}`);
  }

  const data = (await response.json()) as RpcResponse;
  if (typeof data !== 'object' || data === null) {
    throw createError('provider_parse_error', 'Invalid provider payload');
  }
  return data;
}

async function fetchNativeBalance(address: string, rpcUrl: string): Promise<number> {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [address],
  };

  try {
    const data = (await fetchRpc(payload, rpcUrl)) as RpcResponse;
    return parseSolBalance(data);
  } catch (error) {
    if ((error as WalletHoldingsError).code === 'provider_timeout') {
      throw error;
    }
    throw createError('provider_error', error instanceof Error ? error.message : 'Provider request failed');
  }
}

function parseTokenAccounts(data: unknown, network: SolanaNetwork): WalletHoldingsTokenBalance[] {
  const parsed = (data as RpcTokenAccountsResult) || {};
  if (parsed.error) {
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : 'Provider RPC error';
    throw createError('provider_error', message);
  }

  const values = parsed.result?.value;
  if (!Array.isArray(values)) {
    return [];
  }

  const tokenMints = {
    SOL: getMintForNetwork(network, 'SOL'),
    USDC: getMintForNetwork(network, 'USDC'),
  };

  return values
    .map((entry) => normalizeTokenAccount(entry as RpcTokenAccountParsed, network, tokenMints))
    .filter((balance): balance is WalletHoldingsTokenBalance => balance !== null);
}

async function fetchSplTokenAccounts(address: string, rpcUrl: string, network: SolanaNetwork): Promise<WalletHoldingsTokenBalance[]> {
  const payload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'getParsedTokenAccountsByOwner',
    params: [
      address,
      { programId: getTokenProgramId(network) },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
  };

  try {
    const data = await fetchRpc(payload, rpcUrl);
    return parseTokenAccounts(data, network);
  } catch (error) {
    if (getStableErrorCode(error) === 'provider_timeout' || isNetworkConfigError(error)) {
      throw error;
    }
    throw createError('provider_error', error instanceof Error ? error.message : 'Provider request failed');
  }
}

export async function fetchWalletHoldings(input: WalletHoldingsQuery): Promise<WalletHoldingsResponse> {
  const network = resolveSolanaNetwork(input.network);
  let address: string;
  try {
    address = validateWalletAddress(input.address);
  } catch {
    throw createError('invalid_address', 'Invalid wallet address');
  }

  const networkConfig = getSolanaNetworkConfig(network);
  const rpcUrl = networkConfig.rpcUrl;
  if (!rpcUrl) {
    throw createError('unsupported_network', 'Missing RPC endpoint for devnet');
  }

  let nativeLamports: number;
  try {
    nativeLamports = await fetchNativeBalance(address, rpcUrl);
  } catch (error) {
    const code = getStableErrorCode(error);
    if (code === 'provider_timeout' || code === 'unsupported_network') {
      throw error;
    }
    if (isNetworkConfigError(error)) {
      throw createError('invalid_mint_config', error instanceof Error ? error.message : 'Invalid devnet mint configuration');
    }
    if (code === 'provider_error' || code === 'provider_parse_error') {
      throw createError('provider_error', error instanceof Error ? error.message : 'Provider request failed');
    }
    throw createError('provider_error', error instanceof Error ? error.message : 'Unknown holdings provider error');
  }

  const nativeUiAmount = nativeLamports / 1_000_000_000;
  const nativeBalance: WalletHoldingsTokenBalance = {
    symbol: 'SOL',
    mint: networkConfig.mints.SOL,
    amount: String(nativeLamports),
    decimals: 9,
    ui_amount: nativeUiAmount,
    usd_value: 0,
  };

  try {
    const splBalances = await fetchSplTokenAccounts(address, rpcUrl, network);
    const balances = [nativeBalance, ...splBalances];
    return {
      network,
      balances,
      total_usd: 0,
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    const code = getStableErrorCode(error);
    if (isNetworkConfigError(error)) {
      throw createError('invalid_mint_config', error instanceof Error ? error.message : 'Invalid devnet mint configuration');
    }
    if (code === 'provider_error' || code === 'provider_parse_error' || code === 'provider_timeout') {
      return {
        network,
        balances: [nativeBalance],
        total_usd: 0,
        updated_at: new Date().toISOString(),
        partial: true,
        warnings: [
          {
            code: 'spl_holdings_unavailable',
            message: error instanceof Error ? error.message : 'SPL token holdings unavailable',
          },
        ],
      };
    }
    throw createError('provider_error', error instanceof Error ? error.message : 'Unknown holdings provider error');
  }
}

export function getUsdcMint(network?: SolanaNetwork): string {
  return getMintForNetwork(resolveSolanaNetwork(network), 'USDC');
}

export function getSolMint(network?: SolanaNetwork): string {
  return getMintForNetwork(resolveSolanaNetwork(network), 'SOL');
}
