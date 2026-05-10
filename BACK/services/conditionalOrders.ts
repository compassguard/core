import { createHash } from 'node:crypto';
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  clusterApiUrl,
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PROGRAM_ID = process.env.CONDITIONAL_ESCROW_BUY_PROGRAM_ID || 'G6RB5XQwcnXXp34vDot3ERcbGS8RcXUtacMhgXAM8P7n';
const INDEX_POLL_MS = Number(process.env.CONDITIONAL_ORDER_INDEX_INTERVAL_MS || '15000');
const ORACLE_POLL_MS = Number(process.env.CONDITIONAL_ORDER_ORACLE_POLL_MS || '10000');
const EXECUTE_BACKOFF_MS = Number(process.env.CONDITIONAL_ORDER_EXECUTE_BACKOFF_MS || '45000');
const KEEP_ORDER_EXECUTION = process.env.CONDITIONAL_ORDER_KEEPER_ENABLED === 'true';
const KEEP_ORDER_KEYPAIR_JSON = process.env.CONDITIONAL_ORDER_KEEPER_KEYPAIR || process.env.KEEPER_KEYPAIR_JSON;

const VAULT_CONFIG_SEED = Buffer.from('vault-config');
const SOL_VAULT_SEED = Buffer.from('sol-vault');
const ESCROW_AUTHORITY_SEED = Buffer.from('escrow-authority');

const PYTH_PRICE_ACCOUNT_SIZE = 3312;
const PYTH_MAGIC = 0xa1b2c3d4;
const PYTH_VERSION = 2;
const PYTH_PRICE_TYPE = 3;
const PYTH_STATUS_TRADING = 1;

const STATUS_OPEN = 1;
const STATUS_EXECUTED = 2;
const STATUS_CANCELLED = 3;
const STATUS_EXPIRED = 4;
const STATUS_RECLAIMED = 5;

type OnChainStatus = 'open' | 'executed' | 'cancelled' | 'expired' | 'reclaimed' | 'unknown';

export type ConditionalOrderSnapshot = {
  orderPda: string;
  user: string;
  recipient: string;
  clientOrderId: number;
  usdcTestMint: string;
  escrowTokenAccount: string;
  treasuryUsdcAta: string;
  solVaultPda: string;
  oracleFeed: string;
  desiredSolLamports: number;
  maxUsdcIn: number;
  targetPriceUsdE8: number;
  maxOracleAgeSeconds: number;
  maxConfidenceBps: number;
  escrowedUsdcAmount: number;
  executedUsdcAmount: number;
  executedSolLamports: number;
  createdAt: number;
  expiresAt: number;
  status: OnChainStatus;
  observedExecutable: boolean;
  observedExecutableReason?: string;
  indexedAt: number;
};

type RawOrderRecord = {
  order: Omit<ConditionalOrderSnapshot, 'orderPda' | 'status' | 'observedExecutable' | 'observedExecutableReason' | 'indexedAt'>;
  status: number;
  indexedAt: number;
};

type DecodedOrder = RawOrderRecord['order'] & {
  status: number;
};

export type OracleSnapshot = {
  priceUsdE8: number;
  confidence: number;
  exponent: number;
  timestampUnix: number;
  observedAt: number;
};

const orderIndex = new Map<string, RawOrderRecord>();
const userIndex = new Map<string, Set<string>>();
const failureState = new Map<string, { nextAttemptAt: number; errorCount: number; lastReason?: string }>();
let pollerHandle: ReturnType<typeof setInterval> | null = null;
let oraclePollerHandle: ReturnType<typeof setInterval> | null = null;

const oracleLookup = new Map<string, OracleSnapshot>();
const programOracleLookupTtlSec = Math.max(10, Math.floor(ORACLE_POLL_MS / 1000));

function getConnection() {
  const rpc = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');
  return new Connection(rpc, 'confirmed');
}

function getProgram(): PublicKey {
  return new PublicKey(PROGRAM_ID);
}

function mapStatus(status: number): OnChainStatus {
  if (status === STATUS_OPEN) return 'open';
  if (status === STATUS_EXECUTED) return 'executed';
  if (status === STATUS_CANCELLED) return 'cancelled';
  if (status === STATUS_EXPIRED) return 'expired';
  if (status === STATUS_RECLAIMED) return 'reclaimed';
  return 'unknown';
}

function vaultConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_CONFIG_SEED], getProgram())[0];
}

function solVaultPda(vaultConfig: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SOL_VAULT_SEED, vaultConfig.toBuffer()], getProgram())[0];
}

function escrowAuthorityPda(order: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([ESCROW_AUTHORITY_SEED, order.toBuffer()], getProgram())[0];
}

function ataAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function readPubkey(buf: Buffer, cursor: number): { value: PublicKey; cursor: number } {
  return {
    value: new PublicKey(buf.slice(cursor, cursor + 32)),
    cursor: cursor + 32,
  };
}

function readU64(buf: Buffer, cursor: number): { value: number; cursor: number } {
  return { value: Number(buf.readBigUInt64LE(cursor)), cursor: cursor + 8 };
}

function readI64(buf: Buffer, cursor: number): { value: number; cursor: number } {
  return { value: Number(buf.readBigInt64LE(cursor)), cursor: cursor + 8 };
}

function readU32(buf: Buffer, cursor: number): { value: number; cursor: number } {
  return { value: buf.readUInt32LE(cursor), cursor: cursor + 4 };
}

function readU16(buf: Buffer, cursor: number): { value: number; cursor: number } {
  return { value: buf.readUInt16LE(cursor), cursor: cursor + 2 };
}

function decodeOrderAccount(data: Uint8Array): DecodedOrder | null {
  const buf = Buffer.from(data);
  const minLen = 8 + 32 * 7 + 8 + 8 + 8 + 4 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1;
  if (buf.length < minLen) return null;

  let cursor = 8; // Anchor discriminator
  const user = readPubkey(buf, cursor); cursor = user.cursor;
  const recipient = readPubkey(buf, cursor); cursor = recipient.cursor;
  const clientOrderId = readU64(buf, cursor); cursor = clientOrderId.cursor;
  const usdcTestMint = readPubkey(buf, cursor); cursor = usdcTestMint.cursor;
  const escrowTokenAccount = readPubkey(buf, cursor); cursor = escrowTokenAccount.cursor;
  const treasuryUsdcAta = readPubkey(buf, cursor); cursor = treasuryUsdcAta.cursor;
  const solVaultPda = readPubkey(buf, cursor); cursor = solVaultPda.cursor;
  const oracleFeed = readPubkey(buf, cursor); cursor = oracleFeed.cursor;
  const desiredSolLamports = readU64(buf, cursor); cursor = desiredSolLamports.cursor;
  const maxUsdcIn = readU64(buf, cursor); cursor = maxUsdcIn.cursor;
  const targetPriceUsdE8 = readU64(buf, cursor); cursor = targetPriceUsdE8.cursor;
  const maxOracleAgeSeconds = readU32(buf, cursor); cursor = maxOracleAgeSeconds.cursor;
  const maxConfidenceBps = readU16(buf, cursor); cursor = maxConfidenceBps.cursor;
  const escrowedUsdcAmount = readU64(buf, cursor); cursor = escrowedUsdcAmount.cursor;
  const executedUsdcAmount = readU64(buf, cursor); cursor = executedUsdcAmount.cursor;
  const executedSolLamports = readU64(buf, cursor); cursor = executedSolLamports.cursor;
  const createdAt = readI64(buf, cursor); cursor = createdAt.cursor;
  const expiresAt = readI64(buf, cursor); cursor = expiresAt.cursor;
  const escrowAuthorityBump = buf[cursor];
  const status = buf[cursor + 1];
  const accountBump = buf[cursor + 2];
  if (escrowAuthorityBump === undefined || status === undefined || accountBump === undefined) {
    return null;
  }

  return {
    user: user.value.toBase58(),
    recipient: recipient.value.toBase58(),
    clientOrderId: clientOrderId.value,
    usdcTestMint: usdcTestMint.value.toBase58(),
    escrowTokenAccount: escrowTokenAccount.value.toBase58(),
    treasuryUsdcAta: treasuryUsdcAta.value.toBase58(),
    solVaultPda: solVaultPda.value.toBase58(),
    oracleFeed: oracleFeed.value.toBase58(),
    desiredSolLamports: desiredSolLamports.value,
    maxUsdcIn: maxUsdcIn.value,
    targetPriceUsdE8: targetPriceUsdE8.value,
    maxOracleAgeSeconds: maxOracleAgeSeconds.value,
    maxConfidenceBps: maxConfidenceBps.value,
    escrowedUsdcAmount: escrowedUsdcAmount.value,
    executedUsdcAmount: executedUsdcAmount.value,
    executedSolLamports: executedSolLamports.value,
    createdAt: createdAt.value,
    expiresAt: expiresAt.value,
    status,
  };
}

function parsePyth(raw: Buffer): OracleSnapshot | null {
  if (raw.length < PYTH_PRICE_ACCOUNT_SIZE) return null;
  if (raw.readUInt32LE(0) !== PYTH_MAGIC) return null;
  if (raw.readUInt32LE(4) !== PYTH_VERSION) return null;
  if (raw.readUInt32LE(8) !== PYTH_PRICE_TYPE) return null;
  if (raw.readUInt32LE(224) !== PYTH_STATUS_TRADING) return null;

  return {
    priceUsdE8: Number(raw.readBigInt64LE(208)),
    confidence: Number(raw.readBigUInt64LE(216)),
    exponent: raw.readInt32LE(20),
    timestampUnix: Number(raw.readBigInt64LE(296)),
    observedAt: Math.floor(Date.now() / 1000),
  };
}

function normalizeToE8(priceRaw: number, exponent: number): number | null {
  if (!Number.isFinite(priceRaw) || !Number.isFinite(exponent)) return null;
  if (exponent === -8) return priceRaw;
  if (exponent < -8) {
    const factor = Math.pow(10, -8 - exponent);
    if (!Number.isFinite(factor) || factor === 0) return null;
    return Math.floor(priceRaw / factor);
  }
  const factor = Math.pow(10, exponent + 8);
  if (!Number.isFinite(factor)) return null;
  return Number.isFinite(priceRaw * factor) ? Math.floor(priceRaw * factor) : null;
}

function pythConfBps(confidence: number, priceE8: number): number {
  const priceAbs = Math.abs(priceE8);
  if (!Number.isFinite(confidence) || !Number.isFinite(priceAbs) || priceAbs <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor((confidence * 10_000) / priceAbs);
}

function computeRequiredUsdc(desiredSolLamports: number, oraclePriceE8: number): number {
  const usdcDecimals = Number(process.env.USDC_TEST_DECIMALS || '6');
  const safeDecimals = Math.max(0, Math.min(18, Number.isFinite(usdcDecimals) ? Math.floor(usdcDecimals) : 6));
  const lamports = BigInt(desiredSolLamports);
  const price = BigInt(oraclePriceE8);
  const usdcScale = BigInt(10) ** BigInt(safeDecimals);
  const denominator = BigInt(LAMPORTS_PER_SOL) * BigInt(10_00000000);
  return Number((lamports * price * usdcScale + denominator - BigInt(1)) / denominator);
}

function evaluateExecutable(order: RawOrderRecord, oracle: OracleSnapshot | null): { executable: boolean; reason: string } {
  const now = Math.floor(Date.now() / 1000);
  if (now > order.order.expiresAt) return { executable: false, reason: 'order_expired' };
  if (!oracle) return { executable: false, reason: 'oracle_not_fetched' };
  if (now - oracle.timestampUnix > order.order.maxOracleAgeSeconds) return { executable: false, reason: 'oracle_stale' };

  const normalizedPriceE8 = normalizeToE8(oracle.priceUsdE8, oracle.exponent);
  if (!normalizedPriceE8) return { executable: false, reason: 'invalid_oracle_price' };
  if (normalizedPriceE8 > order.order.targetPriceUsdE8) return { executable: false, reason: 'price_above_target' };

  const confBps = pythConfBps(oracle.confidence, normalizedPriceE8);
  if (confBps > order.order.maxConfidenceBps) return { executable: false, reason: 'oracle_confidence_too_high' };

  try {
    const required = computeRequiredUsdc(order.order.desiredSolLamports, normalizedPriceE8);
    if (required > order.order.maxUsdcIn) return { executable: false, reason: 'required_exceeds_max_usdc_in' };
    if (required > order.order.escrowedUsdcAmount) return { executable: false, reason: 'insufficient_escrow' };
  } catch {
    return { executable: false, reason: 'math_overflow' };
  }

  return { executable: true, reason: 'ready' };
}

function toSnapshot(pda: string, raw: RawOrderRecord): ConditionalOrderSnapshot {
  const evaluation = evaluateExecutable(raw, latestOracleSnapshot(raw.order.oracleFeed));
  return {
    orderPda: pda,
    ...raw.order,
    status: mapStatus(raw.status),
    observedExecutable: evaluation.executable,
    observedExecutableReason: evaluation.reason,
    indexedAt: raw.indexedAt,
  };
}

async function getOracleSnapshot(oracleFeed: string): Promise<OracleSnapshot | null> {
  const cached = oracleLookup.get(oracleFeed);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.observedAt < programOracleLookupTtlSec) return cached;

  const conn = getConnection();
  const account = await conn.getAccountInfo(new PublicKey(oracleFeed), 'confirmed');
  if (!account?.data) return null;

  const parsed = parsePyth(Buffer.from(account.data));
  if (parsed) oracleLookup.set(oracleFeed, parsed);
  return parsed;
}

function latestOracleSnapshot(oracleFeed: string): OracleSnapshot | null {
  return oracleLookup.get(oracleFeed) || null;
}

async function refreshTrackedOracles(): Promise<void> {
  const feeds = new Set<string>();
  for (const raw of orderIndex.values()) {
    if (mapStatus(raw.status) === 'open') {
      feeds.add(raw.order.oracleFeed);
    }
  }

  await Promise.all(Array.from(feeds).map((feed) => getOracleSnapshot(feed)));
}

function shouldBackoffNow(orderPda: string): boolean {
  const state = failureState.get(orderPda);
  if (!state) return false;
  return Date.now() < state.nextAttemptAt;
}

function setFailure(orderPda: string, reason: string): void {
  const previous = failureState.get(orderPda);
  const nextIndex = (previous?.errorCount || 0) + 1;
  const delay = EXECUTE_BACKOFF_MS * Math.min(Math.pow(2, nextIndex - 1), 16);
  failureState.set(orderPda, {
    errorCount: nextIndex,
    lastReason: reason,
    nextAttemptAt: Date.now() + delay,
  });
}

function clearFailure(orderPda: string): void {
  failureState.delete(orderPda);
}

function keeperKeypair(): Keypair | null {
  if (!KEEP_ORDER_KEYPAIR_JSON) return null;
  try {
    const raw = JSON.parse(KEEP_ORDER_KEYPAIR_JSON);
    const secret = Uint8Array.from(raw);
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

async function sendExecuteTx(order: ConditionalOrderSnapshot): Promise<string> {
  const keypair = keeperKeypair();
  if (!keypair) throw new Error('KEEPER_KEYPAIR_NOT_CONFIGURED');

  const connection = getConnection();
  const orderPda = new PublicKey(order.orderPda);
  const user = new PublicKey(order.user);
  const vaultConfig = vaultConfigPda();
  const solVault = solVaultPda(vaultConfig);
  const escrowAuthority = escrowAuthorityPda(orderPda);
  const userUsdcAta = ataAddress(user, new PublicKey(order.usdcTestMint));

  const executeIx = new TransactionInstruction({
    programId: getProgram(),
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      { pubkey: orderPda, isSigner: false, isWritable: true },
      { pubkey: vaultConfig, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(order.recipient), isSigner: false, isWritable: true },
      { pubkey: solVault, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(order.escrowTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(order.treasuryUsdcAta), isSigner: false, isWritable: true },
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(order.oracleFeed), isSigner: false, isWritable: false },
      { pubkey: escrowAuthority, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(order.usdcTestMint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionDiscriminator('execute_order'),
  });

  const latestBlock = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: latestBlock.blockhash,
    instructions: [executeIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature, ...latestBlock }, 'confirmed');
  return signature;
}

export async function getOrdersForUser(userAddress: string): Promise<ConditionalOrderSnapshot[]> {
  if (!pollerHandle) {
    await startConditionalOrderIndexer();
  }
  const user = new PublicKey(userAddress).toBase58();
  const orderIds = userIndex.get(user);
  if (!orderIds || !orderIds.size) {
    await pollConditionalOrders();
  }
  const idsToUse = userIndex.get(user);
  if (!idsToUse) return [];

  const result: ConditionalOrderSnapshot[] = [];
  for (const orderPda of idsToUse) {
    const raw = orderIndex.get(orderPda);
    if (!raw) continue;
    const evalRes = evaluateExecutable(raw, latestOracleSnapshot(raw.order.oracleFeed));
    result.push({
      ...raw.order,
      orderPda,
      status: mapStatus(raw.status),
      observedExecutable: evalRes.executable,
      observedExecutableReason: evalRes.reason,
      indexedAt: raw.indexedAt,
    });
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getOrderDetail(orderPda: string): Promise<ConditionalOrderSnapshot | null> {
  const cached = orderIndex.get(orderPda);
  if (cached) {
    const evalRes = evaluateExecutable(cached, latestOracleSnapshot(cached.order.oracleFeed));
    if (!latestOracleSnapshot(cached.order.oracleFeed)) {
      await getOracleSnapshot(cached.order.oracleFeed);
      const after = evaluateExecutable(cached, latestOracleSnapshot(cached.order.oracleFeed));
      return {
        ...cached.order,
        orderPda,
        status: mapStatus(cached.status),
        observedExecutable: after.executable,
        observedExecutableReason: after.reason,
        indexedAt: cached.indexedAt,
      };
    }
    return {
      ...cached.order,
      orderPda,
      status: mapStatus(cached.status),
      observedExecutable: evalRes.executable,
      observedExecutableReason: evalRes.reason,
      indexedAt: cached.indexedAt,
    };
  }

  const account = await getConnection().getAccountInfo(new PublicKey(orderPda), 'confirmed');
  if (!account?.data) return null;

  const decoded = decodeOrderAccount(account.data);
  if (!decoded) return null;

  const raw: RawOrderRecord = { order: decoded, status: decoded.status, indexedAt: Date.now() };
  orderIndex.set(orderPda, raw);
  const userSet = userIndex.get(decoded.user) || new Set();
  userSet.add(orderPda);
  userIndex.set(decoded.user, userSet);

  const oracle = await getOracleSnapshot(decoded.oracleFeed);
  const evalRes = evaluateExecutable(raw, oracle);
  return {
    ...raw.order,
    orderPda,
    status: mapStatus(raw.status),
    observedExecutable: evalRes.executable,
    observedExecutableReason: evalRes.reason,
    indexedAt: raw.indexedAt,
  };
}

export async function pollConditionalOrders(): Promise<void> {
  const conn = getConnection();
  const accounts = await conn.getProgramAccounts(getProgram(), { commitment: 'confirmed' });
  if (!accounts.length) return;

  const neededOracleFeeds = new Set<string>();
  for (const item of accounts) {
    const decoded = decodeOrderAccount(item.account.data);
    if (!decoded) continue;

    const pda = item.pubkey.toBase58();
    rawOrderFromDecoded(pda, decoded);
    neededOracleFeeds.add(decoded.oracleFeed);
  }

  await Promise.all(Array.from(neededOracleFeeds).map((feed) => getOracleSnapshot(feed)));
}

function rawOrderFromDecoded(orderPda: string, decoded: DecodedOrder): void {
  const { status, ...order } = decoded;
  const raw: RawOrderRecord = {
    order,
    status,
    indexedAt: Date.now(),
  };
  orderIndex.set(orderPda, raw);
  let userSet = userIndex.get(decoded.user);
  if (!userSet) {
    userSet = new Set();
    userIndex.set(decoded.user, userSet);
  }
  userSet.add(orderPda);
}

export async function triggerOrderExecution(orderPda: string): Promise<string> {
  const detail = await getOrderDetail(orderPda);
  if (!detail) throw new Error('ORDER_NOT_FOUND');
  if (!detail.observedExecutable) throw new Error('ORDER_NOT_EXECUTABLE');
  if (!KEEP_ORDER_KEYPAIR_JSON) throw new Error('KEEPER_KEYPAIR_NOT_CONFIGURED');
  const signature = await sendExecuteTx(detail);
  clearFailure(orderPda);
  return signature;
}

export async function pollAndMaybeExecute(): Promise<void> {
  await pollConditionalOrders();
  if (!KEEP_ORDER_EXECUTION) return;
  await refreshTrackedOracles();

  for (const [orderPda, raw] of orderIndex.entries()) {
    if (mapStatus(raw.status) !== 'open') continue;
    const evaluation = evaluateExecutable(raw, latestOracleSnapshot(raw.order.oracleFeed));
    if (!evaluation.executable) continue;
    if (shouldBackoffNow(orderPda)) continue;

    try {
      await sendExecuteTx(toSnapshot(orderPda, raw));
      clearFailure(orderPda);
      console.log('[conditional-orders] keeper execute', { orderPda });
      const updated = { ...raw, status: STATUS_EXECUTED, indexedAt: Date.now() };
      orderIndex.set(orderPda, updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'execution_error';
      setFailure(orderPda, message);
      console.warn('[conditional-orders] keeper execute failed', { orderPda, message });
    }
  }
}

export async function startConditionalOrderIndexer(): Promise<void> {
  if (pollerHandle) return;
  await pollAndMaybeExecute();
  pollerHandle = setInterval(() => {
    void pollAndMaybeExecute();
  }, Math.max(INDEX_POLL_MS, 5000));

  if (!oraclePollerHandle) {
    oraclePollerHandle = setInterval(() => {
      void refreshTrackedOracles();
    }, Math.max(ORACLE_POLL_MS, 1000));
  }
}

export function stopConditionalOrderIndexer(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  if (oraclePollerHandle) {
    clearInterval(oraclePollerHandle);
    oraclePollerHandle = null;
  }
}
