/**
 * Phantom Browser Extension Provider Types
 * https://docs.phantom.app/solana/establishing-a-connection
 */

export interface PhantomPublicKey {
  toBase58(): string;
}

export interface PhantomProvider {
  /** Identifies the provider as Phantom */
  isPhantom: boolean;

  /** The public key of the connected account */
  publicKey: PhantomPublicKey | null;

  /** Check if wallet is connected */
  isConnected: boolean;

  /**
   * Connect to the wallet
   * @param options Connection options
   * @returns Promise resolving to object with publicKey
   */
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomPublicKey }>;

  /**
   * Disconnect from the wallet
   * @returns Promise resolving when disconnected
   */
  disconnect(): Promise<void>;

  /**
   * Sign a transaction
   * @param transaction The transaction to sign
   * @returns Promise resolving to signed transaction
   */
  signTransaction<TTransaction>(transaction: TTransaction): Promise<TTransaction>;

  /**
   * Sign all transactions
   * @param transactions Array of transactions to sign
   * @returns Promise resolving to array of signed transactions
   */
  signAllTransactions<TTransaction>(transactions: TTransaction[]): Promise<TTransaction[]>;

  /**
   * Sign and send a transaction
   * @param transaction Transaction to sign and broadcast
   * @param options Optional signing options
   * @returns Promise resolving to response object
   */
  signAndSendTransaction<TTransaction>(
    transaction: TTransaction,
    options?: { preflightCommitment?: 'processed' | 'confirmed' | 'finalized'; skipPreflight?: boolean }
  ): Promise<{ signature: string } | string>;

  /**
   * Sign a message
   * @param message Message to sign (Uint8Array or string)
   * @param encoding Optional encoding ('utf8' or 'hex')
   * @returns Promise resolving to signature object
   */
  signMessage(message: Uint8Array | string, encoding?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;

  /**
   * Register event listener
   * @param event Event name
   * @param handler Event handler function
   */
  on<TEvent extends PhantomEvent>(event: TEvent, handler: PhantomEventHandler<TEvent>): void;

  /**
   * Remove event listener
   * @param event Event name
   * @param handler Event handler function
   */
  off<TEvent extends PhantomEvent>(event: TEvent, handler: PhantomEventHandler<TEvent>): void;

  /**
   * Request specific features from Phantom
   * @param method Method name
   * @param params Method parameters
   */
  request<TResult = unknown>(args: { method: string; params?: unknown }): Promise<TResult>;
}

/**
 * Phantom event types
 */
export interface PhantomEventPayloads {
  connect: PhantomPublicKey;
  disconnect: void;
  accountChanged: PhantomPublicKey | null;
}

export type PhantomEvent = keyof PhantomEventPayloads;

type PhantomEventHandler<TEvent extends PhantomEvent> = (args: PhantomEventPayloads[TEvent]) => void;

export type PhantomExecutionResult = {
  tx_signature: string;
};

export type PhantomExecutionErrorCode =
  | 'phantom_not_detected'
  | 'phantom_not_connected'
  | 'wallet_mismatch'
  | 'user_rejected'
  | 'account_changed'
  | 'blockhash_expired'
  | 'send_failed'
  | 'unknown';

export type PhantomExecutionError = {
  code: PhantomExecutionErrorCode;
  message: string;
};

/**
 * Helper to check if Phantom is installed and get the provider
 * @returns PhantomProvider or null if not found
 */
export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const walletWindow = window as unknown as Window & {
    phantom?: {
      solana?: PhantomProvider;
    };
  };
  const provider = walletWindow.phantom?.solana;

  if (provider?.isPhantom) {
    return provider;
  }

  return null;
}
