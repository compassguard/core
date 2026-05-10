/**
 * Swap Guard On-Chain Instructions Builder
 * 
 * Builds Solana instructions to invoke the agent-action-guard program
 * for swap price validation against Pyth oracle.
 */

import { web3 } from '@coral-xyz/anchor';
import { createHash } from 'node:crypto';

// Program ID deployed on devnet
const AGENT_ACTION_GUARD_PROGRAM_ID = new web3.PublicKey(
  process.env.AGENT_ACTION_GUARD_PROGRAM_ID || 'ETLBetVBpHeG3pKKqpCaRQYfQ2opMNEKCsrQUyqgyg6s'
);

// Pyth SOL/USD price account on devnet
// This is the actual price account address, NOT the feed ID
// Feed ID (ef0d8b...) is different from the price account address
const PYTH_SOL_USD_PRICE_ACCOUNT_DEVNET = 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix';

function getPythSolUsdFeed(): web3.PublicKey {
  // First check if env var is set and looks like a valid base58 address
  const envFeed = process.env.PYTH_SOL_USD_PRICE_ACCOUNT;
  if (envFeed && envFeed.length >= 32 && envFeed.length <= 44) {
    try {
      return new web3.PublicKey(envFeed);
    } catch {
      // Invalid address, fall through to default
    }
  }
  
  // Use the known devnet price account address
  return new web3.PublicKey(PYTH_SOL_USD_PRICE_ACCOUNT_DEVNET);
}

// Lazy-loaded to avoid initialization errors at module load time
let _pythSolUsdFeed: web3.PublicKey | null = null;
function getPythFeedCached(): web3.PublicKey {
  if (!_pythSolUsdFeed) {
    _pythSolUsdFeed = getPythSolUsdFeed();
  }
  return _pythSolUsdFeed;
}

// Action type for swaps
const ACTION_TYPE_SIMULATED_SWAP = 1;

// Seeds for PDA derivation
const USER_POLICY_SEED = Buffer.from('user_policy');
const ACTION_APPROVAL_SEED = Buffer.from('action_approval');

// Instruction discriminators (first 8 bytes of sha256("global:<instruction_name>"))
function getDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

const DISCRIMINATOR_INITIALIZE_POLICY = getDiscriminator('initialize_policy');
const DISCRIMINATOR_CREATE_ACTION_APPROVAL = getDiscriminator('create_action_approval');
const DISCRIMINATOR_MARK_EXECUTED_IF_SWAP_PRICE_WITHIN_BAND = getDiscriminator('mark_executed_if_swap_price_within_band');

export type SwapGuardParams = {
  userAddress: string;
  quotedPriceUsdE8: bigint;
  inputAmountBaseUnits: bigint;
  minOutputAmountBaseUnits: bigint;
  maxSlippageBps: number;
  maxDeviationBps: number;
  stalenessSeconds: number;
  maxConfidenceBps: number;
  expiresAtUnix: number;
};

export type SwapGuardInstructions = {
  initializePolicyIx: web3.TransactionInstruction | null;
  createApprovalIx: web3.TransactionInstruction;
  markExecutedIx: web3.TransactionInstruction;
  actionHash: Buffer;
  userPolicyPda: web3.PublicKey;
  actionApprovalPda: web3.PublicKey;
};

/**
 * Derive the UserPolicy PDA for a given user
 */
export function deriveUserPolicyPda(user: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [USER_POLICY_SEED, user.toBuffer()],
    AGENT_ACTION_GUARD_PROGRAM_ID
  );
}

/**
 * Derive the ActionApproval PDA for a given user and action hash
 */
export function deriveActionApprovalPda(
  user: web3.PublicKey,
  actionHash: Buffer
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [ACTION_APPROVAL_SEED, user.toBuffer(), actionHash],
    AGENT_ACTION_GUARD_PROGRAM_ID
  );
}

/**
 * Generate a unique action hash for a swap
 */
export function generateSwapActionHash(
  user: web3.PublicKey,
  inputAmount: bigint,
  timestamp: number
): Buffer {
  const data = Buffer.alloc(32 + 8 + 8);
  user.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(inputAmount, 32);
  data.writeBigInt64LE(BigInt(timestamp), 40);
  return createHash('sha256').update(data).digest();
}

/**
 * Check if a UserPolicy exists on-chain
 */
export async function checkUserPolicyExists(
  connection: web3.Connection,
  userPolicyPda: web3.PublicKey
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(userPolicyPda);
  return accountInfo !== null && accountInfo.data.length > 0;
}

/**
 * Build the initialize_policy instruction
 */
function buildInitializePolicyInstruction(
  user: web3.PublicKey,
  userPolicyPda: web3.PublicKey
): web3.TransactionInstruction {
  // InitPolicyParams struct:
  // max_transfer_lamports: u64 (8 bytes)
  // max_swap_usd: u64 (8 bytes)
  // max_slippage_bps: u16 (2 bytes)
  // allow_private_actions: bool (1 byte)
  // require_confirmation: bool (1 byte)
  // enabled: bool (1 byte)
  const paramsData = Buffer.alloc(8 + 8 + 2 + 1 + 1 + 1);
  let offset = 0;
  
  // max_transfer_lamports: 10 SOL default
  paramsData.writeBigUInt64LE(BigInt(10 * web3.LAMPORTS_PER_SOL), offset);
  offset += 8;
  
  // max_swap_usd: 10000 USD default (in e8 format would be stored differently, but here raw)
  paramsData.writeBigUInt64LE(BigInt(10000), offset);
  offset += 8;
  
  // max_slippage_bps: 500 (5%)
  paramsData.writeUInt16LE(500, offset);
  offset += 2;
  
  // allow_private_actions: false
  paramsData.writeUInt8(0, offset);
  offset += 1;
  
  // require_confirmation: true
  paramsData.writeUInt8(1, offset);
  offset += 1;
  
  // enabled: true
  paramsData.writeUInt8(1, offset);

  const instructionData = Buffer.concat([DISCRIMINATOR_INITIALIZE_POLICY, paramsData]);

  return new web3.TransactionInstruction({
    programId: AGENT_ACTION_GUARD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userPolicyPda, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });
}

/**
 * Build the create_action_approval instruction
 */
function buildCreateActionApprovalInstruction(
  user: web3.PublicKey,
  userPolicyPda: web3.PublicKey,
  actionApprovalPda: web3.PublicKey,
  params: {
    agent: web3.PublicKey;
    actionHash: Buffer;
    actionType: number;
    inputAmount: bigint;
    minOutputAmount: bigint;
    maxSlippageBps: number;
    recipient: web3.PublicKey;
    targetPriceUsdE8: bigint;
    oracleFeed: web3.PublicKey;
    expiresAt: bigint;
  }
): web3.TransactionInstruction {
  // CreateActionApprovalParams struct:
  // agent: Pubkey (32 bytes)
  // action_hash: [u8; 32] (32 bytes)
  // action_type: u8 (1 byte)
  // input_amount: u64 (8 bytes)
  // min_output_amount: u64 (8 bytes)
  // max_slippage_bps: u16 (2 bytes)
  // recipient: Pubkey (32 bytes)
  // target_price_usd_e8: u64 (8 bytes)
  // oracle_feed: Pubkey (32 bytes)
  // expires_at: i64 (8 bytes)
  const paramsData = Buffer.alloc(32 + 32 + 1 + 8 + 8 + 2 + 32 + 8 + 32 + 8);
  let offset = 0;

  params.agent.toBuffer().copy(paramsData, offset);
  offset += 32;

  params.actionHash.copy(paramsData, offset);
  offset += 32;

  paramsData.writeUInt8(params.actionType, offset);
  offset += 1;

  paramsData.writeBigUInt64LE(params.inputAmount, offset);
  offset += 8;

  paramsData.writeBigUInt64LE(params.minOutputAmount, offset);
  offset += 8;

  paramsData.writeUInt16LE(params.maxSlippageBps, offset);
  offset += 2;

  params.recipient.toBuffer().copy(paramsData, offset);
  offset += 32;

  paramsData.writeBigUInt64LE(params.targetPriceUsdE8, offset);
  offset += 8;

  params.oracleFeed.toBuffer().copy(paramsData, offset);
  offset += 32;

  paramsData.writeBigInt64LE(params.expiresAt, offset);

  const instructionData = Buffer.concat([DISCRIMINATOR_CREATE_ACTION_APPROVAL, paramsData]);

  return new web3.TransactionInstruction({
    programId: AGENT_ACTION_GUARD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userPolicyPda, isSigner: false, isWritable: false },
      { pubkey: actionApprovalPda, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });
}

/**
 * Build the mark_executed_if_swap_price_within_band instruction
 */
function buildMarkExecutedIfSwapPriceWithinBandInstruction(
  user: web3.PublicKey,
  actionApprovalPda: web3.PublicKey,
  oracleFeed: web3.PublicKey,
  params: {
    quotedPriceUsdE8: bigint;
    maxDeviationBps: number;
    stalenessSeconds: bigint;
    maxConfidenceBps: bigint;
  }
): web3.TransactionInstruction {
  // Arguments:
  // quoted_price_usd_e8: u64 (8 bytes)
  // max_deviation_bps: u16 (2 bytes)
  // staleness_seconds: u64 (8 bytes)
  // max_confidence_bps: u64 (8 bytes)
  const argsData = Buffer.alloc(8 + 2 + 8 + 8);
  let offset = 0;

  argsData.writeBigUInt64LE(params.quotedPriceUsdE8, offset);
  offset += 8;

  argsData.writeUInt16LE(params.maxDeviationBps, offset);
  offset += 2;

  argsData.writeBigUInt64LE(params.stalenessSeconds, offset);
  offset += 8;

  argsData.writeBigUInt64LE(params.maxConfidenceBps, offset);

  const instructionData = Buffer.concat([
    DISCRIMINATOR_MARK_EXECUTED_IF_SWAP_PRICE_WITHIN_BAND,
    argsData,
  ]);

  return new web3.TransactionInstruction({
    programId: AGENT_ACTION_GUARD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: actionApprovalPda, isSigner: false, isWritable: true },
      { pubkey: oracleFeed, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });
}

/**
 * Build all guard instructions for a swap
 * 
 * Returns instructions that should be prepended to the swap transaction:
 * 1. initialize_policy (if policy doesn't exist)
 * 2. create_action_approval
 * 3. mark_executed_if_swap_price_within_band
 */
export async function buildSwapGuardInstructions(
  connection: web3.Connection,
  params: SwapGuardParams
): Promise<SwapGuardInstructions> {
  const user = new web3.PublicKey(params.userAddress);
  const [userPolicyPda] = deriveUserPolicyPda(user);
  
  // Generate unique action hash for this swap
  const timestamp = Math.floor(Date.now() / 1000);
  const actionHash = generateSwapActionHash(user, params.inputAmountBaseUnits, timestamp);
  const [actionApprovalPda] = deriveActionApprovalPda(user, actionHash);

  // Check if user policy exists
  const policyExists = await checkUserPolicyExists(connection, userPolicyPda);

  // 1. Initialize policy instruction (only if needed)
  const initializePolicyIx = policyExists
    ? null
    : buildInitializePolicyInstruction(user, userPolicyPda);

  // 2. Create action approval instruction
  // Using user as agent (self-approval pattern)
  const createApprovalIx = buildCreateActionApprovalInstruction(
    user,
    userPolicyPda,
    actionApprovalPda,
    {
      agent: user, // Self-approval
      actionHash,
      actionType: ACTION_TYPE_SIMULATED_SWAP,
      inputAmount: params.inputAmountBaseUnits,
      minOutputAmount: params.minOutputAmountBaseUnits,
      maxSlippageBps: params.maxSlippageBps,
      recipient: user, // Swap output goes to self
      targetPriceUsdE8: params.quotedPriceUsdE8,
      oracleFeed: getPythFeedCached(),
      expiresAt: BigInt(params.expiresAtUnix),
    }
  );

  // 3. Mark executed with price validation instruction
  const markExecutedIx = buildMarkExecutedIfSwapPriceWithinBandInstruction(
    user,
    actionApprovalPda,
    getPythFeedCached(),
    {
      quotedPriceUsdE8: params.quotedPriceUsdE8,
      maxDeviationBps: params.maxDeviationBps,
      stalenessSeconds: BigInt(params.stalenessSeconds),
      maxConfidenceBps: BigInt(params.maxConfidenceBps),
    }
  );

  return {
    initializePolicyIx,
    createApprovalIx,
    markExecutedIx,
    actionHash,
    userPolicyPda,
    actionApprovalPda,
  };
}

/**
 * Get the Pyth oracle feed public key
 */
export function getPythOracleFeed(): web3.PublicKey {
  return getPythFeedCached();
}

/**
 * Get the guard program ID
 */
export function getGuardProgramId(): web3.PublicKey {
  return AGENT_ACTION_GUARD_PROGRAM_ID;
}
