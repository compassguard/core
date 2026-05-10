import { Connection, PublicKey } from '@solana/web3.js';

export type OnchainApprovalProof = {
  execute_tx_signature: string;
};

function getConnection() {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  return new Connection(rpc, 'confirmed');
}

export async function verifyOracleExecutionTx(proof: OnchainApprovalProof): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const programId = process.env.AGENT_ACTION_GUARD_PROGRAM_ID;
  if (!programId) return { ok: false, reason: 'AGENT_ACTION_GUARD_PROGRAM_ID_NOT_CONFIGURED' };

  const conn = getConnection();
  const tx = await conn.getTransaction(proof.execute_tx_signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

  if (!tx || tx.meta?.err) return { ok: false, reason: 'EXECUTE_TX_NOT_CONFIRMED' };

  const expectedProgram = new PublicKey(programId).toBase58();
  const hasProgramInvocation = tx.transaction.message.compiledInstructions.some((ix) => {
    const programKey = tx.transaction.message.staticAccountKeys[ix.programIdIndex];
    return programKey?.toBase58() === expectedProgram;
  });

  if (!hasProgramInvocation) {
    return { ok: false, reason: 'EXECUTE_TX_MISSING_AGENT_ACTION_GUARD_INSTRUCTION' };
  }

  return { ok: true };
}
