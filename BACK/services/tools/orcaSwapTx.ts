import { web3, BN } from '@coral-xyz/anchor';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { DEVNET_SOL_MINT, DEVNET_SOL_USDC_POOL, DEVNET_USDC_MINT } from './orcaSwap';

type WalletStub = {
  publicKey: web3.PublicKey;
  signTransaction: <T extends web3.Transaction | web3.VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends web3.Transaction | web3.VersionedTransaction>(txs: T[]) => Promise<T[]>;
};

export async function buildUnsignedOrcaSwapTx(params: {
  userAddress: string;
  inputToken: 'USDC' | 'SOL';
  outputToken: 'USDC' | 'SOL';
  inputAmount: number;
  slippageBps?: number;
}): Promise<{ unsignedTxBase64: string; recentBlockhash: string; lastValidBlockHeight: number; isVersioned: boolean }> {
  const supportedPair =
    (params.inputToken === 'USDC' && params.outputToken === 'SOL') ||
    (params.inputToken === 'SOL' && params.outputToken === 'USDC');
  if (!supportedPair) {
    throw new Error('unsupported_swap_pair');
  }
  const connection = new web3.Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  const userPubkey = new web3.PublicKey(params.userAddress);
  const slippageBps = params.slippageBps ?? 100;

  const walletStub: WalletStub = {
    publicKey: userPubkey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };

  const ctx = WhirlpoolContext.from(connection, walletStub as any);
  const client = buildWhirlpoolClient(ctx);

  const poolPubkey = new web3.PublicKey(DEVNET_SOL_USDC_POOL);
  const whirlpool = await client.getPool(poolPubkey);

  const inputIsUsdc = params.inputToken === 'USDC';
  const inputAmount = new BN(
    Math.round(params.inputAmount * (inputIsUsdc ? 1_000_000 : 1_000_000_000))
  );
  const slippage = Percentage.fromFraction(slippageBps, 10_000);

  const quote = await swapQuoteByInputToken(
    whirlpool,
    new web3.PublicKey(inputIsUsdc ? DEVNET_USDC_MINT : DEVNET_SOL_MINT),
    inputAmount,
    slippage,
    ctx.program.programId,
    ctx.fetcher,
    IGNORE_CACHE
  );

  // Build the swap transaction
  const txBuilder = await whirlpool.swap(quote, userPubkey);
  
  // Get fresh blockhash right before building
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  
  // Build with the fresh blockhash
  const txPayload = await txBuilder.build({ latestBlockhash: { blockhash, lastValidBlockHeight } });
  const tx = txPayload.transaction;
  const extraSigners = txPayload.signers.filter((signer): signer is web3.Signer => signer !== undefined);

  // Orca may require additional non-wallet signers (for example wrapped SOL flows).
  // Apply those signatures server-side before handing the transaction to Phantom.
  const isVersioned = tx instanceof web3.VersionedTransaction;
  let serialized: Uint8Array;
  
  if (isVersioned) {
    if (extraSigners.length > 0) {
      tx.sign(extraSigners);
    }
    serialized = tx.serialize();
  } else {
    tx.feePayer = userPubkey;
    tx.recentBlockhash = blockhash;
    extraSigners.forEach((signer) => tx.partialSign(signer));
    serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  }

  const base64Tx = Buffer.from(serialized).toString('base64');

  return {
    unsignedTxBase64: base64Tx,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    isVersioned,
  };
}
