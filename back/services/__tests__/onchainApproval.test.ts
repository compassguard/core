import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { web3 } from '@coral-xyz/anchor';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

import {
  deriveActionApprovalAddress,
  deriveWalletSafetyAttestationAddress,
  verifyActionApproval,
  verifyOracleExecutionTx,
  verifyTransferGuardReadiness,
} from '@hosted/onchain/onchainApproval';

const PROGRAM_ID = '11111111111111111111111111111111';
const USER = '11111111111111111111111111111111';
const RECIPIENT = 'So11111111111111111111111111111111111111112';
const ATTESTOR = USER;

function guardedTransferDiscriminator(): string {
  return createHash('sha256').update('global:guarded_transfer').digest().subarray(0, 8).toString('base64');
}

const txWithGuardedTransfer = {
  transaction: {
    message: {
      compiledInstructions: [{ programIdIndex: 0, data: guardedTransferDiscriminator() }],
      staticAccountKeys: [new web3.PublicKey(PROGRAM_ID)],
    },
  },
  meta: { err: null },
};

const txWithoutGuardedTransfer = {
  transaction: {
    message: {
      compiledInstructions: [{ programIdIndex: 0, data: Buffer.from('AAAA', 'base64').toString('base64') }],
      staticAccountKeys: [new web3.PublicKey(PROGRAM_ID)],
    },
  },
  meta: { err: null },
};

function encodeActionApprovalAccount(options: {
  user: string;
  agent: string;
  actionHash: string;
  actionType: number;
  inputAmount: number;
  expiresAtSec: number;
  recipient: string;
  executed: boolean;
  revoked: boolean;
}): Uint8Array {
  const buffer = Buffer.alloc(206);
  let offset = 8;

  buffer.fill(0, 0, 8);
  buffer.set(new PublicKey(options.user).toBuffer(), offset); offset += 32;
  buffer.set(new PublicKey(options.agent).toBuffer(), offset); offset += 32;
  buffer.set(Buffer.from(options.actionHash, 'hex'), offset); offset += 32;
  buffer.writeUInt8(options.actionType, offset); offset += 1;
  buffer.writeBigUInt64LE(BigInt(options.inputAmount), offset); offset += 8;
  buffer.writeBigUInt64LE(BigInt(0), offset); offset += 8;
  buffer.writeUInt16LE(0, offset); offset += 2;
  buffer.set(new PublicKey(options.recipient).toBuffer(), offset); offset += 32;
  buffer.writeBigUInt64LE(BigInt(0), offset); offset += 8;
  buffer.set(web3.SystemProgram.programId.toBuffer(), offset); offset += 32;
  buffer.writeBigUInt64LE(BigInt(options.expiresAtSec), offset); offset += 8;
  buffer.writeUInt8(options.executed ? 1 : 0, offset); offset += 1;
  buffer.writeUInt8(options.revoked ? 1 : 0, offset); offset += 1;
  buffer.writeUInt8(0, offset);

  return buffer;
}

function encodeWalletSafetyAttestationAccount(options: {
  user: string;
  recipient: string;
  actionHash: string;
  attestor: string;
  issuedAtSec: number;
  expiresAtSec: number;
  active: boolean;
}): Uint8Array {
  const buffer = Buffer.alloc(156);
  let offset = 8;

  buffer.fill(0, 0, 8);
  buffer.set(new PublicKey(options.user).toBuffer(), offset); offset += 32;
  buffer.set(new PublicKey(options.recipient).toBuffer(), offset); offset += 32;
  buffer.set(Buffer.from(options.actionHash, 'hex'), offset); offset += 32;
  buffer.set(new PublicKey(options.attestor).toBuffer(), offset); offset += 32;
  buffer.writeBigInt64LE(BigInt(options.issuedAtSec), offset); offset += 8;
  buffer.writeBigInt64LE(BigInt(options.expiresAtSec), offset); offset += 8;
  buffer.writeUInt16LE(0, offset); offset += 2;
  buffer.writeUInt8(options.active ? 1 : 0, offset); offset += 1;
  buffer.writeUInt8(0, offset);

  return buffer;
}

describe('onchainApproval', () => {
  beforeEach(() => {
    process.env.AGENT_ACTION_GUARD_PROGRAM_ID = PROGRAM_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives deterministic action approval PDA', () => {
    const first = deriveActionApprovalAddress({
      user: USER,
      actionHash: 'ab'.repeat(32),
    });

    const second = deriveActionApprovalAddress({
      user: USER,
      actionHash: 'ab'.repeat(32),
    });

    expect(first.address).toBe(second.address);
    expect(first.bump).toBe(second.bump);
  });

  it('returns invalid format reason when action_hash has bad format', async () => {
    vi.spyOn(web3.Connection.prototype, 'getTransaction').mockResolvedValue(txWithGuardedTransfer as never);

    const result = await verifyActionApproval({
      execute_tx_signature: 'test',
      action_hash: 'bad-hash',
      user: USER,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ACTION_HASH_INVALID_FORMAT');
  });

  it('requires action hash and user before accepting a guarded transfer tx proof', async () => {
    vi.spyOn(web3.Connection.prototype, 'getTransaction').mockResolvedValue(txWithGuardedTransfer as never);

    const result = await verifyActionApproval({
      execute_tx_signature: 'test',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INCOMPLETE_ACTION_APPROVAL_PROOF');
  });

  it('returns execution invalid when tx does not include guarded_transfer instruction', async () => {
    vi.spyOn(web3.Connection.prototype, 'getTransaction').mockResolvedValue(txWithoutGuardedTransfer as never);

    const result = await verifyActionApproval({
      execute_tx_signature: 'test',
      user: USER,
      action_hash: 'ab'.repeat(32),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EXECUTE_TX_MISSING_AGENT_ACTION_GUARD_INSTRUCTION');
  });

  it('returns approval mismatch for recipient mismatch', async () => {
    const actionHash = 'ab'.repeat(32);
    const actionType = 0;
    const amount = 1000;
    const accountData = encodeActionApprovalAccount({
      user: USER,
      agent: PROGRAM_ID,
      actionHash,
      actionType,
      inputAmount: amount,
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
      recipient: '2N7jXKx6yR3gk7Q8iW5y2Y9G7dR4f8K7m2vWf7xR8Dq7',
      executed: false,
      revoked: false,
    });

    vi.spyOn(web3.Connection.prototype, 'getTransaction').mockResolvedValue(txWithGuardedTransfer as never);
    vi.spyOn(web3.Connection.prototype, 'getAccountInfo').mockResolvedValue({
      data: accountData,
    } as never);

    const result = await verifyActionApproval({
      execute_tx_signature: 'test',
      action_hash: actionHash,
      user: USER,
      recipient: RECIPIENT,
      amount_lamports: amount,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ONCHAIN_ACTION_APPROVAL_RECIPIENT_MISMATCH');
  });

  it('returns false when AGENT_ACTION_GUARD_PROGRAM_ID not configured', async () => {
    delete process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
    const result = await verifyOracleExecutionTx({ execute_tx_signature: 'noop' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED');
  });

  it('validates transfer readiness for matching approval and attestation', async () => {
    const nowMs = Date.now();
    const actionHash = 'ab'.repeat(32);
    const expiresAtSec = Math.floor(nowMs / 1000) + 1200;
    const amount = 1000000000;
    const actionApproval = encodeActionApprovalAccount({
      user: USER,
      agent: PROGRAM_ID,
      actionHash,
      actionType: 0,
      inputAmount: amount,
      expiresAtSec,
      recipient: RECIPIENT,
      executed: false,
      revoked: false,
    });
    const attestation = encodeWalletSafetyAttestationAccount({
      user: USER,
      recipient: RECIPIENT,
      actionHash,
      attestor: ATTESTOR,
      issuedAtSec: Math.floor(nowMs / 1000) - 10,
      expiresAtSec: Math.floor(nowMs / 1000) + 600,
      active: true,
    });

    vi.spyOn(web3.Connection.prototype, 'getAccountInfo').mockImplementation(async (publicKey) => {
      const { address: actionApprovalPda } = deriveActionApprovalAddress({
        user: USER,
        actionHash,
      });
      const { address: attestationPda } = deriveWalletSafetyAttestationAddress({
        user: USER,
        recipient: RECIPIENT,
        actionHash,
      });

      if (publicKey.toBase58() === actionApprovalPda) {
        return { data: actionApproval } as never;
      }
      if (publicKey.toBase58() === attestationPda) {
        return { data: attestation } as never;
      }
      return null;
    });

    const result = await verifyTransferGuardReadiness({
      user: USER,
      action_hash: actionHash,
      recipient: RECIPIENT,
      amount_lamports: amount,
      actionApprovalPda: deriveActionApprovalAddress({ user: USER, actionHash }).address,
      walletSafetyAttestationPda: deriveWalletSafetyAttestationAddress({ user: USER, recipient: RECIPIENT, actionHash }).address,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects transfer readiness when readying PDA differs from derived', async () => {
    const actionHash = 'ab'.repeat(32);
    const amount = 1000000000;
    const nowSec = Math.floor(Date.now() / 1000);
    const actionApproval = encodeActionApprovalAccount({
      user: USER,
      agent: PROGRAM_ID,
      actionHash,
      actionType: 0,
      inputAmount: amount,
      expiresAtSec: nowSec + 1200,
      recipient: RECIPIENT,
      executed: false,
      revoked: false,
    });
    const attestation = encodeWalletSafetyAttestationAccount({
      user: USER,
      recipient: RECIPIENT,
      actionHash,
      attestor: ATTESTOR,
      issuedAtSec: nowSec - 20,
      expiresAtSec: nowSec + 200,
      active: true,
    });

    vi.spyOn(web3.Connection.prototype, 'getAccountInfo').mockImplementation(async (publicKey) => {
      const { address: actionApprovalPda } = deriveActionApprovalAddress({
        user: USER,
        actionHash,
      });
      const { address: attestationPda } = deriveWalletSafetyAttestationAddress({
        user: USER,
        recipient: RECIPIENT,
        actionHash,
      });
      if (publicKey.toBase58() === actionApprovalPda) return { data: actionApproval } as never;
      if (publicKey.toBase58() === attestationPda) return { data: attestation } as never;
      return null;
    });

    const result = await verifyTransferGuardReadiness({
      user: USER,
      action_hash: actionHash,
      recipient: RECIPIENT,
      amount_lamports: amount,
      actionApprovalPda: deriveWalletSafetyAttestationAddress({ user: USER, recipient: RECIPIENT, actionHash }).address,
      walletSafetyAttestationPda: deriveWalletSafetyAttestationAddress({ user: USER, recipient: RECIPIENT, actionHash }).address,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ONCHAIN_ACTION_APPROVAL_PDA_MISMATCH');
  });
});
