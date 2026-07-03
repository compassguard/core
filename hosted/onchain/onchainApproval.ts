import { PublicKey, Connection } from '@solana/web3.js';

import { createHash } from 'node:crypto';

type BypassProof = {
  execute_tx_signature: string;
  expected_signer?: string;
  expected_network?: 'devnet' | 'mainnet-beta';
};

export type OnchainApprovalProof = BypassProof;

type ActionApprovalRecord = {
  user: string;
  agent: string;
  action_hash: string;
  action_type: number;
  input_amount: number;
  min_output_amount: number;
  max_slippage_bps: number;
  recipient: string;
  target_price_usd_e8: number;
  oracle_feed: string;
  expires_at: number;
  executed: boolean;
  revoked: boolean;
  bump: number;
};

export type WalletSafetyAttestationRecord = {
  user: string;
  recipient: string;
  action_hash: string;
  attestor: string;
  issued_at: number;
  expires_at: number;
  risk_score_bps: number;
  active: boolean;
  bump: number;
};

export type OnchainActionApprovalProof = OnchainApprovalProof & {
  action_hash?: string;
  user?: string;
  recipient?: string;
  amount_lamports?: number;
  action_approval_pda?: string;
  wallet_safety_attestation_pda?: string;
};

type WithReason = {
  ok: boolean;
  reason?: string;
  actionApprovalMissing?: boolean;
  walletSafetyAttestationMissing?: boolean;
};

const ACTION_APPROVAL_ACCOUNT_LEN = 206;
const WALLET_SAFETY_ATTESTATION_ACCOUNT_LEN = 156;

function getProgramId(): PublicKey | null {
  const programId = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  return programId ? new PublicKey(programId) : null;
}

function toUnixSeconds(dateMs: number): number {
  return Math.floor(dateMs / 1000);
}

function getConnection() {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new Connection(rpc, 'confirmed');
}

function normalizeActionHash(actionHash?: string): string | null {
  if (!actionHash) return null;
  const normalized = actionHash.toLowerCase().trim();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function readBool(value: number): boolean {
  return value !== 0;
}

function readU64(data: Buffer, offset: number): number {
  return Number(data.readBigUInt64LE(offset));
}

function readI64(data: Buffer, offset: number): number {
  return Number(data.readBigInt64LE(offset));
}

function readU16(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

function parseActionApprovalAccountData(raw: Buffer): ActionApprovalRecord | null {
  if (raw.length < ACTION_APPROVAL_ACCOUNT_LEN) return null;

  // Anchor prefix/discriminator
  const data = raw.subarray(8);
  if (data.length < ACTION_APPROVAL_ACCOUNT_LEN - 8) return null;

  let offset = 0;

  const readPubkey = () => new PublicKey(data.slice(offset, offset + 32)).toBase58();

  const user = readPubkey();
  offset += 32;
  const agent = readPubkey();
  offset += 32;
  const actionHash = Buffer.from(data.slice(offset, offset + 32)).toString('hex');
  offset += 32;
  const actionType = data.readUInt8(offset);
  offset += 1;
  const inputAmount = readU64(data, offset);
  offset += 8;
  const minOutputAmount = readU64(data, offset);
  offset += 8;
  const maxSlippageBps = readU16(data, offset);
  offset += 2;
  const recipient = readPubkey();
  offset += 32;
  const targetPriceUsdE8 = readU64(data, offset);
  offset += 8;
  const oracleFeed = readPubkey();
  offset += 32;
  const expiresAt = readI64(data, offset);
  offset += 8;
  const executed = readBool(data.readUInt8(offset));
  offset += 1;
  const revoked = readBool(data.readUInt8(offset));
  offset += 1;
  const bump = data.readUInt8(offset);

  if (
    !Number.isFinite(inputAmount) ||
    !Number.isFinite(minOutputAmount) ||
    !Number.isFinite(targetPriceUsdE8) ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }

  return {
    user,
    agent,
    action_hash: actionHash,
    action_type: actionType,
    input_amount: inputAmount,
    min_output_amount: minOutputAmount,
    max_slippage_bps: maxSlippageBps,
    recipient,
    target_price_usd_e8: targetPriceUsdE8,
    oracle_feed: oracleFeed,
    expires_at: expiresAt,
    executed,
    revoked,
    bump,
  };
}

function parseWalletSafetyAttestationAccountData(raw: Buffer): WalletSafetyAttestationRecord | null {
  if (raw.length < WALLET_SAFETY_ATTESTATION_ACCOUNT_LEN) return null;

  const data = raw.subarray(8);
  if (data.length < WALLET_SAFETY_ATTESTATION_ACCOUNT_LEN - 8) return null;

  let offset = 0;

  const readPubkey = () => new PublicKey(data.slice(offset, offset + 32)).toBase58();
  const readActionHash = () => Buffer.from(data.slice(offset, offset + 32)).toString('hex');

  const user = readPubkey();
  offset += 32;
  const recipient = readPubkey();
  offset += 32;
  const actionHash = readActionHash();
  offset += 32;
  const attestor = readPubkey();
  offset += 32;
  const issuedAt = readI64(data, offset);
  offset += 8;
  const expiresAt = readI64(data, offset);
  offset += 8;
  const riskScoreBps = readU16(data, offset);
  offset += 2;
  const active = readBool(data.readUInt8(offset));
  offset += 1;
  const bump = data.readUInt8(offset);

  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(riskScoreBps)) {
    return null;
  }

  return {
    user,
    recipient,
    action_hash: actionHash,
    attestor,
    issued_at: issuedAt,
    expires_at: expiresAt,
    risk_score_bps: riskScoreBps,
    active,
    bump,
  };
}

function getInstructionDiscriminator(data?: string): string | null {
  if (!data || typeof data !== 'string') return null;
  if (/^[A-Za-z0-9+/=]+$/.test(data)) {
    try {
      const decoded = Buffer.from(data, 'base64');
      if (decoded.length < 8) return null;
      return decoded.slice(0, 8).toString('hex');
    } catch {
      return null;
    }
  }

  return null;
}

function txHasAgentActionGuardInvocation(
  tx: { compiledInstructions: { programIdIndex: number; data?: string }[]; staticAccountKeys: { toBase58: () => string }[] } | null
): boolean {
  if (!tx || !('compiledInstructions' in tx) || !('staticAccountKeys' in tx) || !process.env.AGENT_ACTION_GUARD_PROGRAM_ID) {
    return false;
  }

  const expectedProgram = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  const guardedTransferDiscriminator = getGuardedTransferDiscriminator();

  const hasInvocation = tx.compiledInstructions.some((ix) => {
    const index = ix.programIdIndex;
    const accountKey = tx.staticAccountKeys[index];
    if (accountKey?.toBase58() !== expectedProgram) return false;

    const discriminator = getInstructionDiscriminator(ix.data);
    if (!discriminator) return false;

    return discriminator === guardedTransferDiscriminator;
  });

  if (!hasInvocation) return false;

  return true;
}

function getGuardedTransferDiscriminator(): string {
  return createHash('sha256').update('global:guarded_transfer').digest().subarray(0, 8).toString('hex');
}

export function deriveActionApprovalAddress(params: {
  user: string;
  actionHash: string;
  programId?: string;
}): { address: string; bump: number } {
  const normalized = normalizeActionHash(params.actionHash);
  if (!normalized) {
    throw new Error('Invalid action hash format');
  }

  const programIdRaw = params.programId || process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programIdRaw) throw new Error('AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED');

  const programId = new PublicKey(programIdRaw);
  const user = new PublicKey(params.user);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('action_approval'), user.toBuffer(), Buffer.from(normalized, 'hex')],
    programId,
  );
  return { address: pda.toBase58(), bump };
}

export function deriveWalletSafetyAttestationAddress(params: {
  user: string;
  recipient: string;
  actionHash: string;
  programId?: string;
}): { address: string; bump: number } {
  const normalized = normalizeActionHash(params.actionHash);
  if (!normalized) {
    throw new Error('Invalid action hash format');
  }

  const programIdRaw = params.programId || process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programIdRaw) throw new Error('AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED');

  const programId = new PublicKey(programIdRaw);
  const user = new PublicKey(params.user);
  const recipient = new PublicKey(params.recipient);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('wallet_safety_attestation'), user.toBuffer(), recipient.toBuffer(), Buffer.from(normalized, 'hex')],
    programId,
  );
  return { address: pda.toBase58(), bump };
}

export async function fetchActionApprovalAccount(params: {
  user: string;
  actionHash: string;
  programId?: string;
}): Promise<ActionApprovalRecord | null> {
  const programId = params.programId || process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) return null;

  const connection = getConnection();
  const derived = deriveActionApprovalAddress({
    user: params.user,
    actionHash: params.actionHash,
    programId,
  });
  const info = await connection.getAccountInfo(new PublicKey(derived.address));
  if (!info?.data || !info.data.length) return null;

  return parseActionApprovalAccountData(Buffer.from(info.data));
}

export async function fetchWalletSafetyAttestationAccount(params: {
  user: string;
  recipient: string;
  actionHash: string;
  programId?: string;
}): Promise<WalletSafetyAttestationRecord | null> {
  const programId = params.programId || process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) return null;

  const connection = getConnection();
  const derived = deriveWalletSafetyAttestationAddress({
    user: params.user,
    recipient: params.recipient,
    actionHash: params.actionHash,
    programId,
  });
  const info = await connection.getAccountInfo(new PublicKey(derived.address));
  if (!info?.data || !info.data.length) return null;

  return parseWalletSafetyAttestationAccountData(Buffer.from(info.data));
}

export async function verifyOracleExecutionTx(proof: OnchainApprovalProof): Promise<WithReason> {
  const programId = getProgramId();
  if (!programId) return { ok: false, reason: 'AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED' };

  const expectedNetwork = proof.expected_network || 'devnet';
  if (expectedNetwork === 'mainnet-beta') {
    return { ok: false, reason: 'MAINNET_GUARD_PROOF_NOT_SUPPORTED_IN_MVP' };
  }

  const conn = getConnection();
  const tx = await conn.getTransaction(proof.execute_tx_signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

  if (!tx || tx.meta?.err) return { ok: false, reason: 'EXECUTE_TX_NOT_CONFIRMED' };

  const hasProgramInvocation = txHasAgentActionGuardInvocation(tx.transaction.message as never);
  if (!hasProgramInvocation) {
    return { ok: false, reason: 'EXECUTE_TX_MISSING_AGENT_ACTION_GUARD_INSTRUCTION' };
  }

  if (proof.expected_signer) {
    const firstInstructionAccount = tx.transaction.message.staticAccountKeys[0];
    if (!firstInstructionAccount || firstInstructionAccount.toBase58() !== proof.expected_signer) {
      return { ok: false, reason: 'EXECUTE_TX_SIGNER_MISMATCH' };
    }
  }

  return { ok: true };
}

export async function verifyActionApproval(proof: OnchainActionApprovalProof): Promise<WithReason> {
  const base = await verifyOracleExecutionTx(proof);
  if (!base.ok) return base;

  if (!proof.action_hash || !proof.user) {
    return { ok: false, reason: 'INCOMPLETE_ACTION_APPROVAL_PROOF' };
  }

  const normalizedActionHash = normalizeActionHash(proof.action_hash);
  if (!normalizedActionHash) {
    return { ok: false, reason: 'ACTION_HASH_INVALID_FORMAT' };
  }

  const approval = await fetchActionApprovalAccount({ user: proof.user, actionHash: normalizedActionHash });
  if (!approval) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_ACCOUNT_MISSING' };
  }

  if (proof.action_approval_pda) {
    const expectedActionApproval = deriveActionApprovalAddress({
      user: proof.user,
      actionHash: normalizedActionHash,
    });
    if (proof.action_approval_pda !== expectedActionApproval.address) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_PDA_MISMATCH' };
    }
  }

  if (approval.action_hash !== normalizedActionHash) {
    return { ok: false, reason: 'ONCHAIN_ACTION_HASH_MISMATCH' };
  }

  if (approval.executed) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_ALREADY_EXECUTED' };
  }

  if (approval.revoked) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_REVOKED' };
  }

  if (approval.expires_at <= toUnixSeconds(Date.now())) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_EXPIRED' };
  }

  if (proof.recipient && proof.recipient !== approval.recipient) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_RECIPIENT_MISMATCH' };
  }

  if (proof.amount_lamports !== undefined && proof.amount_lamports !== approval.input_amount) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_AMOUNT_MISMATCH' };
  }

  if (proof.user && proof.user !== approval.user) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_USER_MISMATCH' };
  }

  return { ok: true };
}

export async function verifyTransferGuardReadiness(params: {
  user: string;
  action_hash: string;
  recipient: string;
  amount_lamports: number;
  actionApprovalPda?: string;
  walletSafetyAttestationPda?: string;
  allowMissingApproval?: boolean;
  allowMissingAttestation?: boolean;
}): Promise<WithReason> {
  const normalizedActionHash = normalizeActionHash(params.action_hash);
  if (!normalizedActionHash) {
    return { ok: false, reason: 'ACTION_HASH_INVALID_FORMAT' };
  }

  const approval = await fetchActionApprovalAccount({ user: params.user, actionHash: normalizedActionHash });
  const actionApprovalMissing = !approval;
  if (!approval && !params.allowMissingApproval) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_ACCOUNT_MISSING' };
  }

  const expectedActionApproval = deriveActionApprovalAddress({
    user: params.user,
    actionHash: normalizedActionHash,
  });
  if (params.actionApprovalPda && params.actionApprovalPda !== expectedActionApproval.address) {
    return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_PDA_MISMATCH' };
  }

  if (approval) {
    if (approval.user !== params.user) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_USER_MISMATCH' };
    }

    if (approval.recipient !== params.recipient) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_RECIPIENT_MISMATCH' };
    }

    if (approval.input_amount !== params.amount_lamports) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_AMOUNT_MISMATCH' };
    }

    if (approval.executed) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_ALREADY_EXECUTED' };
    }

    if (approval.revoked) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_REVOKED' };
    }

    if (approval.expires_at <= toUnixSeconds(Date.now())) {
      return { ok: false, reason: 'ONCHAIN_ACTION_APPROVAL_EXPIRED' };
    }
  }

  const attestation = await fetchWalletSafetyAttestationAccount({
    user: params.user,
    recipient: params.recipient,
    actionHash: normalizedActionHash,
  });
  const walletSafetyAttestationMissing = !attestation;
  if (!attestation && !params.allowMissingAttestation) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_ACCOUNT_MISSING' };
  }

  const expectedAttestation = deriveWalletSafetyAttestationAddress({
    user: params.user,
    recipient: params.recipient,
    actionHash: normalizedActionHash,
  });
  if (params.walletSafetyAttestationPda && params.walletSafetyAttestationPda !== expectedAttestation.address) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_PDA_MISMATCH' };
  }

  if (!attestation) {
    return { ok: true, actionApprovalMissing, walletSafetyAttestationMissing };
  }

  if (!attestation.active) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_INACTIVE' };
  }

  if (attestation.user !== params.user) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_USER_MISMATCH' };
  }

  if (attestation.recipient !== params.recipient) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_RECIPIENT_MISMATCH' };
  }

  if (attestation.expires_at <= toUnixSeconds(Date.now())) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_EXPIRED' };
  }

  if (attestation.action_hash !== normalizedActionHash) {
    return { ok: false, reason: 'ONCHAIN_WALLET_SAFETY_ATTESTATION_ACTION_HASH_MISMATCH' };
  }

  return { ok: true, actionApprovalMissing, walletSafetyAttestationMissing };
}