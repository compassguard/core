export type SolanaNetwork = 'devnet';

export type SolanaTokenSymbol = 'SOL' | 'USDC';

export type SolanaNetworkConfig = {
  network: SolanaNetwork;
  rpcUrl: string;
  mints: Record<SolanaTokenSymbol, string>;
  tokenProgramId: string;
};

export type SolanaNetworkErrorCode =
  | 'unsupported_network'
  | 'missing_network_config'
  | 'invalid_network_config';

type SolanaNetworkError = Error & { code: SolanaNetworkErrorCode };

export const DEVNET_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
export const DEVNET_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

const FALLBACK_NETWORK = 'devnet' as const;
function buildDevnetConfig(): SolanaNetworkConfig {
  return {
    network: 'devnet',
    rpcUrl: process.env.SOLANA_RPC_URL?.trim() || DEVNET_RPC_URL,
    mints: {
      SOL: process.env.DEVNET_SOL_MINT?.trim() || DEVNET_SOL_MINT,
      USDC: process.env.DEVNET_USDC_MINT?.trim() || DEVNET_USDC_MINT,
    },
    tokenProgramId: process.env.SOLANA_TOKEN_PROGRAM_ID?.trim() || DEVNET_TOKEN_PROGRAM_ID,
  };
}

function createError(code: SolanaNetworkErrorCode, message: string): SolanaNetworkError {
  const error = new Error(message) as SolanaNetworkError;
  error.code = code;
  return error;
}

export function resolveSolanaNetwork(network?: string | null): SolanaNetwork {
  const requested = network?.trim().toLowerCase() || FALLBACK_NETWORK;
  if (requested !== FALLBACK_NETWORK) {
    throw createError('unsupported_network', `Unsupported network ${requested}`);
  }
  return FALLBACK_NETWORK;
}

export function getSolanaNetworkConfig(network?: string | null): SolanaNetworkConfig {
  const resolved = resolveSolanaNetwork(network);
  const config = resolved === 'devnet' ? buildDevnetConfig() : undefined;
  if (!config) {
    throw createError('missing_network_config', `Missing config for network ${resolved}`);
  }

  const solMint = config.mints.SOL?.trim();
  const usdcMint = config.mints.USDC?.trim();
  if (!solMint || !usdcMint) {
    throw createError('invalid_network_config', `Missing required devnet mints`);
  }

  return {
    ...config,
    mints: {
      SOL: solMint,
      USDC: usdcMint,
    },
  };
}

export function getTokenProgramId(network: SolanaNetwork): string {
  return getSolanaNetworkConfig(network).tokenProgramId;
}

export function getMintForNetwork(network: SolanaNetwork, symbol: SolanaTokenSymbol): string {
  return getSolanaNetworkConfig(network).mints[symbol];
}

export function isSupportedNetwork(network: string | undefined | null): network is SolanaNetwork {
  try {
    resolveSolanaNetwork(network);
    return true;
  } catch {
    return false;
  }
}

export type StableServiceError = SolanaNetworkError;