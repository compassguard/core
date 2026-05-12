import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from '@solana/web3.js';

import { getEnv } from './upstream';

export const DEFAULT_MAX_TRANSFER_SOL = Number(getEnv('WALLET_SAFETY_MAX_TRANSFER_SOL') || '20');
export const DEFAULT_WARN_TRANSFER_SOL = Number(getEnv('WALLET_SAFETY_WARN_TRANSFER_SOL') || '5');

const ACTION_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_SOLSCAN_TIMEOUT_MS = 2500;
const RPC_URL = getEnv('SOLANA_RPC_URL') || 'https://api.devnet.solana.com';
const SOLSCAN_BASE_URL = getEnv('WALLET_SAFETY_SOLSCAN_BASE_URL') || 'https://pro-api.solscan.io/v2.0';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const DEFAULT_WALLET_POLICY_NETWORK = 'devnet';
const ACTION_HASH_PAYLOAD_VERSION = 1;

type ProviderStatus = 'ok' | 'missing' | 'stale' | 'error';

type WalletSafetySeverity = 'info' | 'warning' | 'critical';
export type WalletSafetySource = 'local' | 'onchain' | 'offchain' | 'policy' | 'onchain_approval';

export type WalletSafetyDecision = 'ALLOW' | 'WARN' | 'REJECT';
export type WalletRiskLevel = 'low' | 'medium' | 'critical';

export type WalletSafetyReason = {
  code: string;
  severity: WalletSafetySeverity;
  message: string;
  source: WalletSafetySource;
};

export type WalletSafetyDecisionResult = {
  decision: WalletSafetyDecision;
  riskLevel: WalletRiskLevel;
  hardReject: boolean;
  requiresExtraConfirmation: boolean;
  reasons: WalletSafetyReason[];
  sources: { provider: string; status: ProviderStatus }[];
};

export type LocalWalletValidationResult = {
  valid: boolean;
  recipientCanonical: string;
  userWalletCanonical: string;
  hardRejects: WalletSafetyReason[];
  warnings: WalletSafetyReason[];
};

type OnchainWalletCategory = 'system_wallet' | 'program' | 'token_account' | 'pda_like' | 'unknown';

export type OnchainWalletFacts = {
  recipient: string;
  accountExists: boolean;
  executable?: boolean;
  ownerProgram?: string;
  lamports?: string;
  space?: number;
  accountCategory?: OnchainWalletCategory;
  fetchedAt: string;
  source: 'solana-rpc' | 'helius' | 'mock';
  providerStatus: ProviderStatus;
};

export type OffchainWalletSignals = {
  recipient: string;
  internalLists: {
    onBlocklist: boolean;
    onUserDenylist: boolean;
    onUserAllowlist: boolean;
  };
  reputation: {
    severity: 'none' | 'low' | 'medium' | 'critical';
    reasons: WalletSafetyReason[];
  };
  sanctions?: {
    matched: boolean;
    source: 'ofac' | 'opensanctions' | 'internal';
    checkedAt: string;
  };
  abuseReports: Array<{
    provider: 'hapi' | 'chainabuse' | 'goplus' | 'webacy' | 'custom';
    severity: 'low' | 'medium' | 'critical';
    confidence: 'low' | 'medium' | 'high';
    verified: boolean;
    code: string;
  }>;
  history?: {
    txCountBucket?: 'none' | 'low' | 'medium' | 'high' | 'unknown';
    estimatedAccountAgeBucket?: 'new' | 'recent' | 'established' | 'unknown';
  };
  solscan?: {
    status: ProviderStatus;
    indexed: boolean | null;
    hasHistory: boolean | null;
    checkedAt: string;
  };
  providerStatuses: Array<{ provider: string; status: ProviderStatus }>;
};

export type EvaluateWalletSafetyInput = {
  userWallet: string;
  recipient: string;
  amount: number;
  token?: string;
  memo?: string;
  actionTtlMs?: number;
  userAllowlist?: string[];
  userDenylist?: string[];
};

export type EvaluateWalletSafetyOptions = {
  onchainFetcher?: (recipientCanonical: string) => Promise<OnchainWalletFacts>;
  policy?: Partial<WalletSafetyPolicy>;
  solscanFetcher?: (recipientCanonical: string, config: SolscanRuntimeConfig) => Promise<SolscanLookup>;
  solscanConfig?: Partial<
    Pick<WalletSafetyDefaults, 'solscanEnabled' | 'solscanTimeoutMs' | 'solscanBaseUrl' | 'solscanApiKey'>
  > & Partial<SolscanRuntimeConfig>;
  now?: () => number;
};

export type WalletSafetyEvaluation = {
  decisionResult: WalletSafetyDecisionResult;
  localValidation: LocalWalletValidationResult;
  onchainFacts: OnchainWalletFacts;
  offchainSignals: OffchainWalletSignals;
  canonicalRecipient: string;
  canonical: CanonicalTransferParams;
  actionHash: string;
  actionExpiry: string;
};

type WalletSafetyDefaults = {
  providerMode: string;
  internalBlocklist: string[];
  internalAllowlist: string[];
  internalDenylist: string[];
  sanctionedWallets: string[];
  solscanEnabled: boolean;
  solscanTimeoutMs: number;
  solscanBaseUrl: string;
  solscanApiKey?: string;
};

type SolscanRuntimeConfig = {
  enabled: boolean;
  timeoutMs: number;
  baseUrl: string;
  apiKey?: string;
};

type SolscanLookup = {
  status: ProviderStatus;
  indexed: boolean | null;
  hasHistory: boolean | null;
  checkedAt: string;
  failureCode?: string;
};

export type CanonicalTransferParams = {
  userWallet: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
};

export type TransferActionHashContext = {
  policyPda: string;
  network?: string;
  actionTtlMs?: number;
};

export type TransferCanonicalMetadata = {
  actionType: string;
  network: string;
  actionHash: string;
  amountLamports: number;
  policyPda: string;
  actionExpiresAt: string;
  actionCreatedAt: string;
};

export type WalletSafetyPolicy = {
  maxAmountSol: number;
  warnAmountSol: number;
  requireAllowlistAboveWarnThreshold: boolean;
  actionTtlMs?: number;
  transferActionType: string;
};

const DEFAULT_POLICY: WalletSafetyPolicy = {
  maxAmountSol: Number.isFinite(DEFAULT_MAX_TRANSFER_SOL) && DEFAULT_MAX_TRANSFER_SOL > 0 ? DEFAULT_MAX_TRANSFER_SOL : 20,
  warnAmountSol: Number.isFinite(DEFAULT_WARN_TRANSFER_SOL) && DEFAULT_WARN_TRANSFER_SOL > 0 ? DEFAULT_WARN_TRANSFER_SOL : 5,
  requireAllowlistAboveWarnThreshold: true,
  actionTtlMs: ACTION_TTL_MS,
  transferActionType: 'TRANSFER_SOL_GUARDED',
};

export const TRANSFER_SOL_GUARDED_ACTION_TYPE = 'TRANSFER_SOL_GUARDED';

function parseEnvBool(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseEnvInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readSolscanPayload(payload: unknown): { txCount?: number; address?: string } {
  if (!payload || typeof payload !== 'object') return {};

  const anyPayload = payload as Record<string, unknown>;
  const data = anyPayload.data as Record<string, unknown> | undefined;
  const record = (data && typeof data === 'object') ? data : undefined;
  const txCount = Number((record?.txCount ?? record?.txnCount ?? record?.tx_count ?? record?.totalTx ?? record?.totalTransactions) || 0);

  const address = typeof anyPayload.address === 'string'
    ? anyPayload.address
    : typeof record?.address === 'string'
      ? record.address
      : undefined;

  return {
    txCount: Number.isFinite(txCount) && txCount > 0 ? txCount : 0,
    address,
  };
}

async function lookupSolscanIndexedRecipient(
  recipientCanonical: string,
  config: SolscanRuntimeConfig,
  fetcher?: (recipientCanonical: string, config: SolscanRuntimeConfig) => Promise<SolscanLookup>
): Promise<SolscanLookup> {
  if (!config.enabled) {
    return {
      status: 'missing',
      indexed: null,
      hasHistory: null,
      checkedAt: new Date().toISOString(),
    };
  }

  if (fetcher) {
    return fetcher(recipientCanonical, config);
  }

  const now = new Date().toISOString();
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/account?address=${encodeURIComponent(recipientCanonical)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        ...(config.apiKey ? { token: config.apiKey } : {}),
      },
      signal: controller.signal,
      method: 'GET',
    });

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        return {
          status: 'error',
          indexed: null,
          hasHistory: null,
          checkedAt: now,
          failureCode: 'PROVIDER_PARTIAL_FAILURE',
        };
      }

      if (response.status === 404 || response.status === 204) {
        return {
          status: 'missing',
          indexed: false,
          hasHistory: false,
          checkedAt: now,
          failureCode: 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN',
        };
      }

      return {
        status: 'error',
        indexed: null,
        hasHistory: null,
        checkedAt: now,
        failureCode: 'PROVIDER_PARTIAL_FAILURE',
      };
    }

    const payload = await response.json();
    const parsed = readSolscanPayload(payload);
    const indexed = Boolean(parsed.address);
    const txCount = parsed.txCount ?? 0;

    return {
      status: indexed ? 'ok' : 'missing',
      indexed,
      hasHistory: txCount > 0,
      checkedAt: now,
      failureCode: !indexed ? 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN' : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 'error',
        indexed: null,
        hasHistory: null,
        checkedAt: now,
        failureCode: 'PROVIDER_PARTIAL_FAILURE',
      };
    }
    return {
      status: 'error',
      indexed: null,
      hasHistory: null,
      checkedAt: now,
      failureCode: 'PROVIDER_PARTIAL_FAILURE',
    };
  } finally {
    clearTimeout(timeout);
  }
}

const CACHE = new Map<string, { fetchedAt: number; value: OnchainWalletFacts }>();

function parseAddressList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => {
      try {
        new PublicKey(v);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function reason(
  code: string,
  message: string,
  source: WalletSafetySource,
  severity: WalletSafetySeverity
): WalletSafetyReason {
  return { code, message, source, severity };
}

function normalizeRecipient(value: string): string {
  return new PublicKey(value).toBase58();
}

function normalizeToken(value?: string): string {
  return (value || 'SOL').trim() || 'SOL';
}

export function getWalletSafetyDefaults() {
  return {
    providerMode: getEnv('WALLET_SAFETY_PROVIDER_MODE') || 'mock',
    internalBlocklist: parseAddressList(getEnv('WALLET_SAFETY_INTERNAL_BLOCKLIST')),
    internalAllowlist: parseAddressList(getEnv('WALLET_SAFETY_INTERNAL_ALLOWLIST')),
    internalDenylist: parseAddressList(getEnv('WALLET_SAFETY_INTERNAL_USER_DENYLIST')),
    sanctionedWallets: parseAddressList(getEnv('WALLET_SAFETY_SANCTIONED_WALLETS')),
    solscanEnabled: parseEnvBool(getEnv('WALLET_SAFETY_SOLSCAN_ENABLED')),
    solscanTimeoutMs: parseEnvInteger(getEnv('WALLET_SAFETY_SOLSCAN_TIMEOUT_MS'), DEFAULT_SOLSCAN_TIMEOUT_MS),
    solscanBaseUrl: getEnv('WALLET_SAFETY_SOLSCAN_BASE_URL') || SOLSCAN_BASE_URL,
    solscanApiKey: getEnv('WALLET_SAFETY_SOLSCAN_API_KEY'),
  };
}

export function buildTransferCanonicalParams(input: {
  userWallet: string;
  recipient: string;
  amount: number;
  token?: string;
  memo?: string;
}): CanonicalTransferParams {
  return {
    userWallet: normalizeRecipient(input.userWallet),
    recipient: normalizeRecipient(input.recipient),
    amount: Number(input.amount),
    token: normalizeToken(input.token),
    memo: input.memo,
  };
}

export function getTransferActionNetwork(networkOverride?: string): string {
  return networkOverride || getEnv('NEXT_PUBLIC_SOLANA_NETWORK') || getEnv('SOLANA_NETWORK') || DEFAULT_WALLET_POLICY_NETWORK;
}

function buildTransferActionPayload(
  canonical: CanonicalTransferParams,
  atMs: number,
  context: Partial<TransferActionHashContext> = {}
): {
  payload: Record<string, string | number>;
  actionExpiresAt: number;
  amountLamports: number;
} {
  const network = getTransferActionNetwork(context.network);
  const actionTtlMs = context.actionTtlMs || ACTION_TTL_MS;
  const amountLamports = Math.round(canonical.amount * 1_000_000_000);
  const actionExpiresAt = atMs + actionTtlMs;

  return {
    payload: {
      v: ACTION_HASH_PAYLOAD_VERSION,
      action_type: TRANSFER_SOL_GUARDED_ACTION_TYPE,
      network,
      userWallet: canonical.userWallet,
      recipient: canonical.recipient,
      amountLamports,
      memo: canonical.memo || '',
      policyPda: context.policyPda,
      expires_at: actionExpiresAt,
    },
    actionExpiresAt,
    amountLamports,
  };
}

export function buildTransferActionHash(
  canonical: CanonicalTransferParams,
  atMs: number,
  context: Partial<TransferActionHashContext> = {}
): string {
  try {
    const policyPda = context.policyPda || deriveWalletPolicyPda({ userWallet: canonical.userWallet }, context.network);
    const { payload } = buildTransferActionPayload(canonical, atMs, { ...context, policyPda });
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } catch {
    return '';
  }
}

export function buildTransferMetadata(
  canonical: CanonicalTransferParams,
  createdAtMs: number,
  context: Partial<TransferActionHashContext> = {}
): TransferCanonicalMetadata {
  const policyPda = context.policyPda || deriveWalletPolicyPda({ userWallet: canonical.userWallet }, context.network);
  const { payload, amountLamports, actionExpiresAt } = buildTransferActionPayload(
    canonical,
    createdAtMs,
    { ...context, policyPda },
  );

  return {
    actionType: payload.action_type as string,
    network: payload.network as string,
    actionHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    amountLamports,
    policyPda,
    actionExpiresAt: new Date(actionExpiresAt).toISOString(),
    actionCreatedAt: new Date(createdAtMs).toISOString(),
  };
}

export function deriveWalletPolicyPda(
  input: {
    userWallet: string;
  },
  programId?: string
): string {
  const pid = programId || getEnv('AGENT_ACTION_GUARD_PROGRAM_ID');
  if (!pid) {
    throw new Error('AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED');
  }

  const user = new PublicKey(input.userWallet);
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_policy'), user.toBuffer()],
    new PublicKey(pid),
  );
  return policyPda.toBase58();
}

export function isPendingActionExpired(expiresAt?: string, nowMs?: number): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= (nowMs || Date.now());
}

export function hasActionHashMismatch(expectedHash?: string, candidateHash?: string): boolean {
  if (!expectedHash || !candidateHash) return true;
  return expectedHash !== candidateHash;
}

export function getActionHashMismatchReason(): WalletSafetyReason {
  return reason('ACTION_HASH_MISMATCH', 'La propuesta fue modificada desde su creación.', 'local', 'critical');
}

function policyDecisionLevel(
  decision: WalletSafetyDecision,
  reasons: WalletSafetyReason[],
  hasProviderError: boolean
): WalletRiskLevel {
  if (decision === 'REJECT') return 'critical';
  if (decision === 'WARN') return hasProviderError ? 'critical' : 'medium';
  return reasons.some((item) => item.severity === 'warning') ? 'medium' : 'low';
}

async function getOnchainFacts(
  recipientCanonical: string,
  overrideFetcher?: (recipientCanonical: string) => Promise<OnchainWalletFacts>
): Promise<OnchainWalletFacts> {
  if (overrideFetcher) {
    return overrideFetcher(recipientCanonical);
  }

  const now = new Date().toISOString();
  const cached = CACHE.get(recipientCanonical);
  if (cached && Date.now() - cached.fetchedAt <= CACHE_TTL_MS) {
    return { ...cached.value, fetchedAt: now, providerStatus: 'ok' };
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const account = await connection.getAccountInfo(new PublicKey(recipientCanonical), {
    commitment: 'confirmed',
  });

  const facts: OnchainWalletFacts = {
    recipient: recipientCanonical,
    accountExists: Boolean(account),
    source: 'solana-rpc',
    providerStatus: 'ok',
    fetchedAt: now,
  };

  if (!account) {
    facts.accountCategory = 'unknown';
    return facts;
  }

  facts.executable = account.executable;
  facts.ownerProgram = account.owner.toBase58();
  facts.lamports = String(account.lamports);
  facts.space = account.data?.length;

  if (account.executable) {
    facts.accountCategory = 'program';
  } else if (account.owner.equals(SystemProgram.programId)) {
    facts.accountCategory = 'system_wallet';
  } else if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    facts.accountCategory = 'token_account';
  } else if (account.owner.equals(SYSVAR_CLOCK_PUBKEY)) {
    facts.accountCategory = 'pda_like';
  } else {
    facts.accountCategory = 'unknown';
  }

  CACHE.set(recipientCanonical, {
    fetchedAt: Date.now(),
    value: facts,
  });

  return facts;
}

async function getOffchainSignals(
  input: EvaluateWalletSafetyInput,
  canonical: CanonicalTransferParams,
  policy: WalletSafetyPolicy,
  options: EvaluateWalletSafetyOptions = {}
): Promise<OffchainWalletSignals> {
  const defaults = getWalletSafetyDefaults();
  const onBlocklist = defaults.internalBlocklist.includes(canonical.recipient);
  const onUserDenylist =
    defaults.internalDenylist.includes(canonical.recipient) || (input.userDenylist || []).includes(canonical.recipient);
  const onUserAllowlist =
    defaults.internalAllowlist.includes(canonical.recipient) || (input.userAllowlist || []).includes(canonical.recipient);

  const reasons: WalletSafetyReason[] = [];
  const solscanConfig: SolscanRuntimeConfig = {
    enabled:
      options.solscanConfig?.solscanEnabled ??
      options.solscanConfig?.enabled ??
      (defaults.providerMode === 'internal-only' ? false : defaults.solscanEnabled),
    timeoutMs: Number.isFinite(options.solscanConfig?.solscanTimeoutMs)
      ? Number(options.solscanConfig?.solscanTimeoutMs)
      : defaults.solscanTimeoutMs,
    baseUrl: options.solscanConfig?.solscanBaseUrl || defaults.solscanBaseUrl,
    apiKey: options.solscanConfig?.solscanApiKey || defaults.solscanApiKey,
  };

  const solscan = await lookupSolscanIndexedRecipient(
    canonical.recipient,
    solscanConfig,
    options.solscanFetcher
  );

  if (solscanConfig.enabled && solscan.status === 'missing' && solscan.indexed === false) {
    reasons.push(
      reason(
        'RECIPIENT_NOT_INDEXED_ON_SOLSCAN',
        `La wallet destino no aparece indexada en Solscan (${canonical.recipient}).`,
        'offchain',
        'warning'
      )
    );
  }

  if (solscanConfig.enabled && solscan.status === 'error') {
    reasons.push(
      reason(
        'PROVIDER_PARTIAL_FAILURE',
        'No se pudo validar Solscan de forma confiable; se mantiene en estado de riesgo.',
        'offchain',
        'warning'
      )
    );
  }

  if (policy.requireAllowlistAboveWarnThreshold && !onUserAllowlist && canonical.token === 'SOL' && canonical.amount > policy.warnAmountSol) {
    reasons.push(
      reason(
        'RECIPIENT_NOT_ALLOWLISTED_OVER_WARN_THRESHOLD',
        `Destino de monto alto (${canonical.amount} SOL) sin allowlist explícita.`,
        'policy',
        'warning'
      )
    );
  }

  const isSanctioned = defaults.sanctionedWallets.includes(canonical.recipient);
  if (isSanctioned) {
    reasons.push(reason('RECIPIENT_SANCTIONED', 'Destino aparece en lista de sanciones.', 'offchain', 'critical'));
  }

  const providerStatuses: { provider: string; status: ProviderStatus }[] =
    defaults.providerMode === 'mock'
      ? [
          { provider: 'internal-list', status: 'ok' as const },
          { provider: 'mock', status: 'ok' as const },
        ]
      : [
          { provider: 'internal-list', status: 'ok' as const },
          { provider: 'ofac', status: isSanctioned ? 'ok' : 'missing' as const },
          { provider: 'hapi', status: 'missing' as const },
          { provider: 'chainabuse', status: 'missing' as const },
          { provider: 'goplus', status: 'missing' as const },
        ];
  if (solscanConfig.enabled) {
    providerStatuses.push({
      provider: 'solscan',
      status: solscan.status,
    });
  }

  return {
    recipient: canonical.recipient,
    internalLists: {
      onBlocklist,
      onUserDenylist,
      onUserAllowlist,
    },
    reputation: {
      severity: reasons.some((item) => item.severity === 'critical')
        ? 'critical'
        : reasons.length
          ? 'medium'
          : 'none',
      reasons,
    },
    sanctions: {
      matched: isSanctioned,
      source: 'ofac',
      checkedAt: new Date().toISOString(),
    },
    abuseReports: [],
    history: {
      txCountBucket: onUserAllowlist ? 'medium' : 'unknown',
      estimatedAccountAgeBucket: onUserAllowlist ? 'established' : 'unknown',
    },
    solscan: {
      status: solscan.status,
      indexed: solscan.indexed,
      hasHistory: solscan.hasHistory,
      checkedAt: solscan.checkedAt,
    },
    providerStatuses,
  };
}

function mergeDecisionReasons(hardRejects: WalletSafetyReason[], reasons: WalletSafetyReason[]): WalletSafetyReason[] {
  const map: Record<string, WalletSafetyReason> = {};
  for (const item of [...hardRejects, ...reasons]) {
    map[item.code] = item;
  }
  return Object.values(map);
}

function getDecision(
  local: LocalWalletValidationResult,
  onchain: OnchainWalletFacts,
  offchain: OffchainWalletSignals
): WalletSafetyDecisionResult {
  const reasons: WalletSafetyReason[] = [...offchain.reputation.reasons, ...local.warnings];
  const hardRejects: WalletSafetyReason[] = [...local.hardRejects];

  if (offchain.internalLists.onBlocklist) {
    hardRejects.push(reason('RECIPIENT_BLOCKLISTED', 'La wallet destino está en listas internas.', 'offchain', 'critical'));
  }

  if (offchain.internalLists.onUserDenylist) {
    hardRejects.push(
      reason('RECIPIENT_USER_DENYLISTED', 'La wallet destino está en denylist de usuario.', 'offchain', 'critical')
    );
  }

  if (offchain.providerStatuses.some((entry) => entry.provider === 'solscan' && entry.status === 'missing')) {
    reasons.push(
      reason(
        'RECIPIENT_NOT_INDEXED_ON_SOLSCAN',
        `La wallet destino no aparece indexada en Solscan (${offchain.recipient}).`,
        'offchain',
        'warning'
      )
    );
  }

  if (offchain.providerStatuses.some((entry) => entry.provider === 'solscan' && entry.status === 'error')) {
    reasons.push(
      reason(
        'PROVIDER_PARTIAL_FAILURE',
        'No se pudo validar Solscan de forma confiable; se mantiene en estado de riesgo.',
        'offchain',
        'warning'
      )
    );
  }

  if (offchain.sanctions?.matched) {
    hardRejects.push(reason('RECIPIENT_CONFIRMED_ABUSE_MATCH', 'Destino confirmado con evento de abuso.', 'offchain', 'critical'));
  }

  if (onchain.accountExists && onchain.executable) {
    hardRejects.push(reason('RECIPIENT_EXECUTABLE', 'Cuenta destino ejecutable.', 'onchain', 'critical'));
  }

  if (!onchain.accountExists) {
    reasons.push(reason('RECIPIENT_ACCOUNT_NOT_FOUND', 'No existe cuenta destino en RPC todavía.', 'onchain', 'warning'));
  }

  const hasProviderError =
    onchain.providerStatus === 'error' || offchain.providerStatuses.some((status) => status.status === 'error');

  if (hardRejects.length > 0 || local.warnings.some((item) => item.severity === 'critical')) {
    return {
      decision: 'REJECT',
      riskLevel: policyDecisionLevel('REJECT', hardRejects, hasProviderError),
      hardReject: true,
      requiresExtraConfirmation: false,
      reasons: mergeDecisionReasons(hardRejects, []),
      sources: [{ provider: onchain.source, status: onchain.providerStatus }, { provider: 'internal', status: 'ok' }, ...offchain.providerStatuses],
    };
  }

  if (reasons.length > 0) {
    return {
      decision: 'WARN',
      riskLevel: policyDecisionLevel('WARN', reasons, hasProviderError),
      hardReject: false,
      requiresExtraConfirmation: true,
      reasons: mergeDecisionReasons([], reasons),
      sources: [{ provider: onchain.source, status: onchain.providerStatus }, { provider: 'internal', status: 'ok' }, ...offchain.providerStatuses],
    };
  }

  return {
    decision: 'ALLOW',
    riskLevel: 'low',
    hardReject: false,
    requiresExtraConfirmation: false,
    reasons: [],
    sources: [{ provider: onchain.source, status: onchain.providerStatus }, { provider: 'internal', status: 'ok' }, ...offchain.providerStatuses],
  };
}

function evaluateLocalValidation(input: EvaluateWalletSafetyInput, policy: WalletSafetyPolicy): LocalWalletValidationResult {
  let recipientCanonical = '';
  let userWalletCanonical = '';
  const hardRejects: WalletSafetyReason[] = [];
  const warnings: WalletSafetyReason[] = [];

  try {
    userWalletCanonical = normalizeRecipient(input.userWallet);
  } catch {
    hardRejects.push(reason('INVALID_PUBLIC_KEY', 'Wallet de origen inválida.', 'local', 'critical'));
  }

  try {
    recipientCanonical = normalizeRecipient(input.recipient);
  } catch {
    hardRejects.push(reason('INVALID_PUBLIC_KEY', 'Wallet destino inválida.', 'local', 'critical'));
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    hardRejects.push(reason('INVALID_AMOUNT', 'Monto debe ser positivo.', 'local', 'critical'));
  }

  if (
    normalizeToken(input.token) === 'SOL' &&
    Number(input.amount) > policy.warnAmountSol &&
    Number(input.amount) <= policy.maxAmountSol
  ) {
    warnings.push(reason('LOW_HISTORY', 'Monto alto requiere aprobación reforzada según política.', 'policy', 'warning'));
  }

  return {
    valid: hardRejects.length === 0,
    recipientCanonical: recipientCanonical || input.recipient,
    userWalletCanonical: userWalletCanonical || input.userWallet,
    hardRejects,
    warnings,
  };
}

export async function evaluateWalletSafety(
  input: EvaluateWalletSafetyInput,
  options: EvaluateWalletSafetyOptions = {}
): Promise<WalletSafetyEvaluation> {
  const policy: WalletSafetyPolicy = {
    ...DEFAULT_POLICY,
    ...options.policy,
  };

  const nowMs = options.now ? options.now() : Date.now();
  const local = evaluateLocalValidation(input, policy);
  const canonical = {
    userWallet: local.userWalletCanonical,
    recipient: local.recipientCanonical,
    amount: Number(input.amount),
    token: normalizeToken(input.token),
    memo: input.memo,
  };

  const offchain = await getOffchainSignals(input, canonical, policy, options);

  let onchain: OnchainWalletFacts;
  if (local.valid && canonical.recipient) {
    try {
      onchain = await getOnchainFacts(canonical.recipient, options.onchainFetcher);
    } catch {
      onchain = {
        recipient: canonical.recipient,
        accountExists: false,
        source: 'mock',
        providerStatus: 'error',
        fetchedAt: new Date(nowMs).toISOString(),
      };
    }
  } else {
    onchain = {
      recipient: canonical.recipient,
      accountExists: false,
      source: 'mock',
      providerStatus: 'missing',
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  if (canonical.amount > policy.maxAmountSol && canonical.token === 'SOL') {
    local.hardRejects.push(
      reason(
        'USER_POLICY_TRANSFER_LIMIT_EXCEEDED',
        `Monto supera el límite máximo de ${policy.maxAmountSol} SOL.`,
        'policy',
        'critical'
      )
    );
    local.valid = false;
  }

  const decision = getDecision(local, onchain, offchain);

  if (!local.valid && decision.decision !== 'REJECT') {
    decision.decision = 'REJECT';
    decision.hardReject = true;
    decision.requiresExtraConfirmation = false;
    decision.riskLevel = 'critical';
    decision.reasons = [
      ...mergeDecisionReasons(decision.reasons, local.hardRejects),
      ...local.warnings,
    ];
  }

  let actionHash = '';
  const actionExpiresAt = nowMs + (input.actionTtlMs || policy.actionTtlMs || ACTION_TTL_MS);
  if (local.valid) {
    try {
      const policyPda = deriveWalletPolicyPda({ userWallet: canonical.userWallet });
      actionHash = buildTransferActionHash(canonical, nowMs, {
        policyPda,
        network: getTransferActionNetwork(),
        actionTtlMs: input.actionTtlMs || policy.actionTtlMs || ACTION_TTL_MS,
      });
    } catch {
      actionHash = '';
    }
  }

  return {
    canonical,
    localValidation: local,
    onchainFacts: onchain,
    offchainSignals: offchain,
    decisionResult: decision,
    canonicalRecipient: canonical.recipient,
    actionHash,
    actionExpiry: new Date(actionExpiresAt).toISOString(),
  };
}

export function mapDecisionToRiskScore(decision: WalletSafetyDecisionResult): {
  score: number;
  level: 'low' | 'medium' | 'critical';
} {
  const reasons = decision.reasons;
  let score = 15;

  if (decision.decision === 'REJECT') {
    score = 95;
  } else if (decision.decision === 'WARN') {
    score = reasons.some((reason) => reason.severity === 'critical') ? 80 : 55;
  } else {
    score = 20;
  }

  return { score, level: decision.riskLevel };
}
