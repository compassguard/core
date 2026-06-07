import { PublicKey } from '@solana/web3.js';

const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const SIGNATURE_LIMIT_MAX = 50;
const SIGNATURE_REQUEST_MULTIPLIER = 1_000;
const RPC_TIMEOUT_MS = 8_000;
const MAX_CURSOR_LENGTH = 128;

type RpcSignaturesResponseItem = {
  signature: unknown;
  err: unknown;
  blockTime?: unknown;
};
type RpcTransactionResponse = {
  result?: RpcSignaturesResponseItem[];
  error?: { message?: unknown };
};
type RpcTransactionDetail = {
  meta?: {
    preBalances?: unknown;
    postBalances?: unknown;
  } | null;
  transaction?: {
    message?: {
      accountKeys?: unknown;
    };
  };
};
type RpcTransactionDetailResponse = {
  result?: RpcTransactionDetail | null;
  error?: { message?: unknown };
};

type TransactionHistoryItem = {
  tx_hash: string;
  type: 'swap' | 'transfer' | 'stake' | 'other';
  status: 'success' | 'failed';
  timestamp: string;
  summary: string;
  amount?: number;
  amount_symbol?: string;
  amount_usd?: number;
  explorer_url: string;
};

export type TransactionHistoryResponse = {
  transactions: TransactionHistoryItem[];
  next_cursor?: string;
};

function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL?.trim() || process.env.VITE_HELIUS_RPC_URL?.trim() || SOLANA_DEVNET_RPC_URL;
}

function buildExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}`;
}

function normalizeCursor(value: string | null): string | undefined {
  if (!value) return undefined;
  const cursor = value.trim();
  return cursor.length === 0 ? undefined : cursor;
}

function isLikelySolanaSignature(value: string): boolean {
  if (!value || value.length > MAX_CURSOR_LENGTH) {
    return false;
  }
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export function normalizeTransactionLimit(value: number): number {
  const sanitized = Math.trunc(value);
  if (!Number.isInteger(sanitized) || sanitized < 1) {
    throw new Error('Invalid limit');
  }
  return Math.min(sanitized, SIGNATURE_LIMIT_MAX);
}

export function validateWalletAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error('Missing address');
  new PublicKey(trimmed);
  return trimmed;
}

export function validateBeforeCursor(cursor: string | undefined): string | undefined {
  const normalized = normalizeCursor(cursor);
  if (!normalized) return undefined;
  if (normalized.length < 40 || !isLikelySolanaSignature(normalized)) {
    throw new Error('Invalid cursor');
  }
  return normalized;
}

function parseRpcSignaturePayload(raw: unknown): RpcSignaturesResponseItem[] {
  const parsed = (raw as RpcTransactionResponse) ?? {};
  if ('error' in parsed && parsed.error) {
    const rawError = parsed.error?.message;
    const msg = typeof rawError === 'string' ? rawError : 'RPC returned error response';
    throw new Error(msg);
  }

  if (!Array.isArray(parsed.result)) {
    throw new Error('RPC response did not include signatures array');
  }

  return parsed.result;
}

function getAccountKeyString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'pubkey' in value) {
    const pubkey = (value as { pubkey?: unknown }).pubkey;
    return typeof pubkey === 'string' ? pubkey : undefined;
  }
  return undefined;
}

function findWalletAccountIndex(detail: RpcTransactionDetail | null | undefined, address: string): number {
  const accountKeys = detail?.transaction?.message?.accountKeys;
  if (!Array.isArray(accountKeys)) return -1;
  return accountKeys.findIndex((accountKey) => getAccountKeyString(accountKey) === address);
}

function getNativeSolDelta(detail: RpcTransactionDetail | null | undefined, address: string): number | undefined {
  const accountIndex = findWalletAccountIndex(detail, address);
  const preBalances = detail?.meta?.preBalances;
  const postBalances = detail?.meta?.postBalances;

  if (accountIndex < 0 || !Array.isArray(preBalances) || !Array.isArray(postBalances)) {
    return undefined;
  }

  const preBalance = preBalances[accountIndex];
  const postBalance = postBalances[accountIndex];
  if (typeof preBalance !== 'number' || typeof postBalance !== 'number') {
    return undefined;
  }

  const deltaLamports = postBalance - preBalance;
  if (deltaLamports === 0) return undefined;
  return deltaLamports / 1_000_000_000;
}

function toTransactionItem(
  signatureData: RpcSignaturesResponseItem,
  transactionDetail: RpcTransactionDetail | null | undefined,
  address: string,
): TransactionHistoryItem {
  if (typeof signatureData.signature !== 'string' || signatureData.signature.length === 0) {
    throw new Error('RPC signature record missing signature');
  }

  const txHash = signatureData.signature;
  const failed = signatureData.err !== null && signatureData.err !== undefined;
  const hasKnownType = false;
  const isSwapOrTransfer = false;

  const nativeSolDelta = getNativeSolDelta(transactionDetail, address);
  const item: TransactionHistoryItem = {
    tx_hash: txHash,
    type: hasKnownType ? (isSwapOrTransfer ? 'swap' : 'other') : 'other',
    status: failed ? 'failed' : 'success',
    timestamp: typeof signatureData.blockTime === 'number' && Number.isFinite(signatureData.blockTime)
      ? new Date(signatureData.blockTime * 1000).toISOString()
      : new Date().toISOString(),
    summary: 'Public Solana transaction',
    explorer_url: buildExplorerUrl(txHash),
  };

  if (nativeSolDelta !== undefined) {
    item.amount = nativeSolDelta;
    item.amount_symbol = 'SOL';
  }

  return item;
}

function getProviderResponseText(response: Response): Promise<unknown> {
  return response.text().then((raw) => {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });
}

async function fetchWithTimeout(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTransactionDetails(
  rpcUrl: string,
  signatures: RpcSignaturesResponseItem[],
): Promise<Map<string, RpcTransactionDetail | null>> {
  const validSignatures = signatures
    .map((signatureData) => signatureData.signature)
    .filter((signature): signature is string => typeof signature === 'string' && signature.length > 0);

  if (validSignatures.length === 0) {
    return new Map();
  }

  const batchBody = validSignatures.map((signature, index) => ({
    jsonrpc: '2.0',
    id: SIGNATURE_REQUEST_MULTIPLIER + index + 1,
    method: 'getTransaction',
    params: [
      signature,
      {
        commitment: 'confirmed' as const,
        encoding: 'jsonParsed' as const,
        maxSupportedTransactionVersion: 0,
      },
    ],
  }));

  let rpcResponse: Response;
  try {
    rpcResponse = await fetchWithTimeout(rpcUrl, batchBody);
  } catch {
    return new Map();
  }

  if (!rpcResponse.ok) {
    await getProviderResponseText(rpcResponse);
    return new Map();
  }

  const parsed: unknown = await rpcResponse.json();
  if (!Array.isArray(parsed)) {
    return new Map();
  }

  return parsed.reduce((details, rawItem, index) => {
    const responseItem = (rawItem as RpcTransactionDetailResponse) ?? {};
    const signature = validSignatures[index];
    if (signature && !responseItem.error) {
      details.set(signature, responseItem.result ?? null);
    }
    return details;
  }, new Map<string, RpcTransactionDetail | null>());
}

export async function fetchWalletTransactions(
  address: string,
  limit: number,
  before?: string,
): Promise<TransactionHistoryResponse> {
  const rpcUrl = getSolanaRpcUrl();
  const requestLimit = Math.min(limit + 1, SIGNATURE_LIMIT_MAX);
  const requestBody = {
    jsonrpc: '2.0',
    id: SIGNATURE_REQUEST_MULTIPLIER,
    method: 'getSignaturesForAddress',
    params: [
      address,
      {
        limit: requestLimit,
        commitment: 'confirmed' as const,
        ...(before ? { before } : {}),
      },
    ],
  };

  let rpcResponse: Response;
  try {
    rpcResponse = await fetchWithTimeout(rpcUrl, requestBody);
  } catch {
    throw new Error('provider_timeout_or_network');
  }

  if (!rpcResponse.ok) {
    await getProviderResponseText(rpcResponse);
    throw new Error(`provider_rpc_status_${rpcResponse.status}`);
  }

  const parsed: unknown = await rpcResponse.json();
  const signatures = parseRpcSignaturePayload(parsed);
  const requestedLimit = normalizeTransactionLimit(limit);
  const hasAdditional = signatures.length > requestedLimit;
  const pageSignatures = hasAdditional ? signatures.slice(0, requestedLimit) : signatures;
  const transactionDetails = await fetchTransactionDetails(rpcUrl, pageSignatures);
  let nextCursor: string | undefined;
  if (hasAdditional) {
    const lastPageSignature = pageSignatures.at(-1)?.signature;
    nextCursor = typeof lastPageSignature === 'string' ? lastPageSignature : undefined;
  }

  return {
    transactions: pageSignatures.map((signatureData) => {
      const detail = typeof signatureData.signature === 'string'
        ? transactionDetails.get(signatureData.signature)
        : undefined;
      return toTransactionItem(signatureData, detail, address);
    }),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}
