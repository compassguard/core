import { createHash } from 'node:crypto';
import { web3 } from '@coral-xyz/anchor';
import { z } from 'zod';

export type ConditionalBuySolParams = {
  input_token: 'USDC';
  input_amount: number;
  target_price_usd: number;
  min_sol_out?: number;
  desired_sol_amount?: number;
  desired_sol_lamports?: number;
  max_usdc_in?: number;
  max_oracle_age_seconds?: number;
  max_confidence_bps?: number;
  recipient?: string;
  expires_at?: string;
  oracle_feed_pubkey?: string;
  client_order_id?: number;
  execution_mode?: 'create_order_and_deposit';
  order_pda?: string;
};

export type ConditionalBuyOrderContract = {
  desired_sol_amount: number;
  desired_sol_lamports: number;
  max_usdc_in: number;
  target_price_usd: number;
  recipient: string;
  expires_at_unix: number;
  client_order_id: number;
  oracle_feed_pubkey: string;
  max_oracle_age_seconds: number;
  max_confidence_bps: number;
  execution_mode: 'create_order_and_deposit';
};

export type ConditionalBuyOrderTxInput = {
  userAddress: string;
  desired_sol_amount: number;
  desired_sol_lamports: number;
  max_usdc_in: number;
  target_price_usd: number;
  recipient: string;
  expires_at_unix: number;
  client_order_id: number;
  oracle_feed_pubkey: string;
  max_oracle_age_seconds: number;
  max_confidence_bps: number;
};

export type ConditionalBuyOrderTxResult = {
  txBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  orderPda: string;
  clientOrderId: number;
  vaultConfig: string;
  solVault: string;
  escrowAuthority: string;
  escrowTokenAccount: string;
};

export type ConditionalBuyDecision =
  | { decision: 'ALLOW_WITH_CONFIRMATION'; reasons: string[] }
  | { decision: 'REJECT'; reasons: string[] };

const CONDITIONAL_ESCROW_BUY_PROGRAM_ID =
  process.env.CONDITIONAL_ESCROW_BUY_PROGRAM_ID ||
  process.env.CONDITIONAL_ESCROW_PROGRAM_ID ||
  'FDwvY7eqeCNn27haATZJbqfnACJTr9YveG6yy9RcUt7u';

const VAULT_CONFIG_SEED = Buffer.from('vault-config');
const ORDER_SEED = Buffer.from('order');
const ESCROW_AUTHORITY_SEED = Buffer.from('escrow-authority');
const SOL_VAULT_SEED = Buffer.from('sol-vault');
const TOKEN_PROGRAM_ID = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID_DEFAULT = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const DEFAULT_ORACLE_FEED =
  process.env.PYTH_SOL_USD_FEED ||
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const DEFAULT_MAX_ORACLE_AGE_SECONDS = Number(process.env.CONDITIONAL_MAX_ORACLE_AGE_SECONDS || '120');
const DEFAULT_MAX_CONFIDENCE_BPS = Number(process.env.CONDITIONAL_MAX_CONFIDENCE_BPS || '500');
const DEFAULT_ORDER_TTL_SECONDS = Number(process.env.CONDITIONAL_ORDER_TTL_SECONDS || '3600');

const DEFAULT_ORDER_EXECUTION_MODE = 'create_order_and_deposit' as const;

function getProgramId() {
  return new web3.PublicKey(CONDITIONAL_ESCROW_BUY_PROGRAM_ID);
}

function getUsdcMint(): web3.PublicKey {
  const mint = process.env.USDC_TEST_MINT;
  if (!mint) {
    throw new Error('USDC_TEST_MINT env var is required');
  }
  return new web3.PublicKey(mint);
}

function getVaultTreasuryUsdcAta(): web3.PublicKey {
  const treasuryAta = process.env.TREASURY_USDC_ATA;
  if (!treasuryAta) {
    throw new Error('TREASURY_USDC_ATA env var is required');
  }
  return new web3.PublicKey(treasuryAta);
}

function getUsdcDecimals(): number {
  const decimals = Number(process.env.USDC_TEST_DECIMALS || '6');
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('USDC_TEST_DECIMALS env var is invalid');
  }
  return Math.floor(decimals);
}

function getAssociatedTokenProgramId(): web3.PublicKey {
  const associatedTokenProgramId = process.env.ASSOCIATED_TOKEN_PROGRAM_ID || ASSOCIATED_TOKEN_PROGRAM_ID_DEFAULT.toBase58();
  return new web3.PublicKey(associatedTokenProgramId);
}

function getOracleAge(config?: number): number {
  const raw = config ?? DEFAULT_MAX_ORACLE_AGE_SECONDS;
  if (!Number.isFinite(raw) || raw < 0) {
    throw new Error('Invalid oracle max age');
  }
  return Math.max(0, Math.floor(raw));
}

function getConfidence(config?: number): number {
  const raw = config ?? DEFAULT_MAX_CONFIDENCE_BPS;
  if (!Number.isFinite(raw) || raw < 0 || raw > 10_000) {
    throw new Error('Invalid oracle confidence bps');
  }
  return Math.floor(raw);
}

function getSolanaConnection() {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new web3.Connection(rpc, 'confirmed');
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function pdaDerive(seed: Buffer, extra: Buffer[] = []): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync([seed, ...extra], getProgramId())[0];
}

function getVaultConfigPda(): web3.PublicKey {
  return pdaDerive(VAULT_CONFIG_SEED);
}

function deriveOrderPda(user: web3.PublicKey, clientOrderId: number): web3.PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(clientOrderId), 0);
  return web3.PublicKey.findProgramAddressSync([ORDER_SEED, user.toBuffer(), idBuf], getProgramId())[0];
}

function deriveEscrowAuthority(orderPda: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync([ESCROW_AUTHORITY_SEED, orderPda.toBuffer()], getProgramId())[0];
}

function deriveSolVaultPda(vaultConfig: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync([SOL_VAULT_SEED, vaultConfig.toBuffer()], getProgramId())[0];
}

function deriveAssociatedTokenAddress(owner: web3.PublicKey, mint: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    getAssociatedTokenProgramId(),
  )[0];
}

function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function writeUInt64(value: bigint, target: Buffer, offset: number): number {
  target.writeBigUInt64LE(value, offset);
  return offset + 8;
}

function writeI64(value: number, target: Buffer, offset: number): number {
  target.writeBigInt64LE(BigInt(Math.floor(value)), offset);
  return offset + 8;
}

function toFixedAtomic(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid amount value: ${value}`);
  }
  const scaled = value * Math.pow(10, decimals);
  if (!Number.isFinite(scaled)) {
    throw new Error('Invalid amount value');
  }

  const fixed = Math.floor(Math.max(0, scaled));
  if (!Number.isFinite(fixed) || fixed > Number.MAX_SAFE_INTEGER) {
    throw new Error('Amount too large to encode');
  }

  return BigInt(fixed);
}

function toE8(value: number): number {
  requireFinitePositive(value, 'target price');
  return Math.floor(value * 100_000_000);
}

function toAtomicSolLamports(value: number): number {
  requireFinitePositive(value, 'desired_sol_amount');
  return Math.floor(value * web3.LAMPORTS_PER_SOL);
}

function deriveInstructionAccounts(input: {
  user: web3.PublicKey;
  userUsdcTokenAccount: web3.PublicKey;
  orderPda: web3.PublicKey;
  escrowAuthority: web3.PublicKey;
  escrowTokenAccount: web3.PublicKey;
  vaultConfig: web3.PublicKey;
  treasuryUsdcAta: web3.PublicKey;
  usdcMint: web3.PublicKey;
  solVault: web3.PublicKey;
  oracleFeed: web3.PublicKey;
}): web3.AccountMeta[] {
  return [
    { pubkey: input.user, isSigner: true, isWritable: true },
    { pubkey: input.userUsdcTokenAccount, isSigner: false, isWritable: true },
    { pubkey: input.orderPda, isSigner: false, isWritable: true },
    { pubkey: input.escrowAuthority, isSigner: false, isWritable: false },
    { pubkey: input.escrowTokenAccount, isSigner: false, isWritable: true },
    { pubkey: input.vaultConfig, isSigner: false, isWritable: true },
    { pubkey: input.treasuryUsdcAta, isSigner: false, isWritable: true },
    { pubkey: input.usdcMint, isSigner: false, isWritable: false },
    { pubkey: input.solVault, isSigner: false, isWritable: false },
    { pubkey: input.oracleFeed, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenProgramId(), isSigner: false, isWritable: false },
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

function resolveDesiredSolAmount(params: ConditionalBuySolParams, fallbackQuoteUsdPrice: number): number {
  const fromParams =
    params.desired_sol_amount && params.desired_sol_amount > 0
      ? params.desired_sol_amount
      : params.min_sol_out && params.min_sol_out > 0
        ? params.min_sol_out
        : 0;

  if (fromParams > 0) {
    return fromParams;
  }

  if (!Number.isFinite(fallbackQuoteUsdPrice) || fallbackQuoteUsdPrice <= 0) {
    throw new Error('Cannot infer desired SOL amount without a valid price estimate');
  }

  return Math.max(0.000001, params.input_amount / fallbackQuoteUsdPrice);
}

export function evaluateConditionalBuy(params: ConditionalBuySolParams): ConditionalBuyDecision {
  if (!Number.isFinite(params.input_amount) || params.input_amount <= 0) {
    return { decision: 'REJECT', reasons: ['INVALID_INPUT_AMOUNT'] };
  }
  if (!Number.isFinite(params.target_price_usd) || params.target_price_usd <= 0) {
    return { decision: 'REJECT', reasons: ['INVALID_TARGET_PRICE'] };
  }
  if (params.min_sol_out !== undefined && (!Number.isFinite(params.min_sol_out) || params.min_sol_out <= 0)) {
    return { decision: 'REJECT', reasons: ['INVALID_MIN_SOL_OUT'] };
  }

  return {
    decision: 'ALLOW_WITH_CONFIRMATION',
    reasons: ['Guardrails will validate order conditions on-chain'],
  };
}

export function toConditionalBuyProposalPayload(
  params: ConditionalBuySolParams,
  userAddress: string,
  quoteUsdPrice: number,
): ConditionalBuyOrderContract & { order_pda?: string; client_order_id: number } {
  const desiredSolAmount = resolveDesiredSolAmount(params, quoteUsdPrice);
  const maxUsdcIn = params.max_usdc_in && params.max_usdc_in > 0 ? params.max_usdc_in : params.input_amount;
  const clientOrderId = params.client_order_id && params.client_order_id > 0 ? params.client_order_id : Math.max(1, Math.floor(Date.now()));

  const requestedExpiry = nowUnixSeconds() + Math.max(60, DEFAULT_ORDER_TTL_SECONDS);

  return {
    desired_sol_amount: desiredSolAmount,
    desired_sol_lamports: toAtomicSolLamports(desiredSolAmount),
    max_usdc_in: Number(maxUsdcIn),
    target_price_usd: Number(params.target_price_usd),
    recipient: params.recipient || userAddress,
    expires_at_unix: requestedExpiry,
    client_order_id: clientOrderId,
    oracle_feed_pubkey: params.oracle_feed_pubkey || DEFAULT_ORACLE_FEED,
    max_oracle_age_seconds: getOracleAge(params.max_oracle_age_seconds),
    max_confidence_bps: getConfidence(params.max_confidence_bps),
    order_pda: '',
    execution_mode: DEFAULT_ORDER_EXECUTION_MODE,
  };
}

export async function buildConditionalBuyCreateOrderTx(input: ConditionalBuyOrderTxInput): Promise<ConditionalBuyOrderTxResult> {
  const user = new web3.PublicKey(input.userAddress);
  const recipient = new web3.PublicKey(input.recipient);
  const usdcMint = getUsdcMint();
  const programId = getProgramId();
  const vaultConfig = getVaultConfigPda();
  const treasuryUsdcAta = getVaultTreasuryUsdcAta();
  const oracleFeed = new web3.PublicKey(input.oracle_feed_pubkey);

  requireFinitePositive(input.desired_sol_amount, 'desired_sol_amount');
  requireFinitePositive(input.max_usdc_in, 'max_usdc_in');
  requireFinitePositive(input.target_price_usd, 'target_price_usd');

  const desiredLamports = Math.max(1, toAtomicSolLamports(input.desired_sol_amount));
  const maxUsdcIn = toFixedAtomic(input.max_usdc_in, getUsdcDecimals());
  const targetPriceE8 = BigInt(toE8(input.target_price_usd));
  const depositAmount = toFixedAtomic(input.max_usdc_in, getUsdcDecimals());
  const clientOrderId = input.client_order_id && input.client_order_id > 0 ? input.client_order_id : Math.max(1, Math.floor(Date.now()));

  const orderPda = deriveOrderPda(user, clientOrderId);
  const escrowAuthority = deriveEscrowAuthority(orderPda);
  const escrowTokenAccount = deriveAssociatedTokenAddress(escrowAuthority, usdcMint);
  const solVault = deriveSolVaultPda(vaultConfig);
  const userUsdcTokenAccount = deriveAssociatedTokenAddress(user, usdcMint);

  const expiresAtUnix = input.expires_at_unix || nowUnixSeconds() + 3600;

  const instructionData = Buffer.alloc(8 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 4 + 2 + 8);
  let offset = 0;
  instructionDiscriminator('create_order_and_deposit').copy(instructionData, offset);
  offset += 8;
  offset = writeUInt64(BigInt(clientOrderId), instructionData, offset);
  offset = writeUInt64(BigInt(desiredLamports), instructionData, offset);
  instructionData.writeBigUInt64LE(maxUsdcIn, offset);
  offset += 8;
  instructionData.writeBigUInt64LE(targetPriceE8, offset);
  offset += 8;
  writeI64(expiresAtUnix, instructionData, offset);
  offset += 8;
  recipient.toBuffer().copy(instructionData, offset);
  offset += 32;
  oracleFeed.toBuffer().copy(instructionData, offset);
  offset += 32;
  instructionData.writeUInt32LE(getOracleAge(input.max_oracle_age_seconds), offset);
  offset += 4;
  instructionData.writeUInt16LE(getConfidence(input.max_confidence_bps), offset);
  offset += 2;
  instructionData.writeBigUInt64LE(depositAmount, offset);

  const instruction = new web3.TransactionInstruction({
    programId,
    keys: deriveInstructionAccounts({
      user,
      userUsdcTokenAccount,
      orderPda,
      escrowAuthority,
      escrowTokenAccount,
      vaultConfig,
      treasuryUsdcAta,
      usdcMint,
      solVault,
      oracleFeed,
    }),
    data: instructionData,
  });

  const connection = getSolanaConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new web3.TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new web3.VersionedTransaction(messageV0);

  return {
    txBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    orderPda: orderPda.toBase58(),
    clientOrderId,
    vaultConfig: vaultConfig.toBase58(),
    solVault: solVault.toBase58(),
    escrowAuthority: escrowAuthority.toBase58(),
    escrowTokenAccount: escrowTokenAccount.toBase58(),
  };
}

export const conditionalBuySolSchema = z.object({
  input_token: z.literal('USDC'),
  input_amount: z.number().positive(),
  target_price_usd: z.number().positive().describe('Buy condition: execute only if SOL/USD <= target_price_usd'),
  desired_sol_amount: z.number().positive().optional(),
  min_sol_out: z.number().positive().optional(),
  max_usdc_in: z.number().positive().optional(),
  max_oracle_age_seconds: z.number().positive().optional(),
  max_confidence_bps: z.number().positive().optional(),
  recipient: z.string().optional(),
  oracle_feed_pubkey: z.string().optional(),
  client_order_id: z.number().optional(),
  execution_mode: z.literal('create_order_and_deposit').optional(),
});
