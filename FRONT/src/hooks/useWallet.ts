import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { web3 } from '@coral-xyz/anchor';
import {
  getPhantomProvider,
  type PhantomExecutionErrorCode,
  type PhantomExecutionResult,
  type PhantomPublicKey,
} from '@/types/phantom';
import { getAllocationFromBalances, getHighlightBalances } from '@/lib/walletBalances';
import { useWalletBalances } from './useWalletBalances';

type WalletState = {
  isConnected: boolean;
  isConnecting: boolean;
  address: string | undefined;
  walletError: string | undefined;
};

type SignAndSendError = Error & {
  code?: PhantomExecutionErrorCode;
};

const INITIAL_WALLET_STATE: WalletState = {
  isConnected: false,
  isConnecting: false,
  address: undefined,
  walletError: undefined,
};

let walletState = INITIAL_WALLET_STATE;
const walletListeners = new Set<() => void>();
let phantomEventsInitialized = false;
let eagerConnectAttempted = false;

function getErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function getWalletSnapshot() {
  return walletState;
}

function subscribeToWallet(listener: () => void) {
  walletListeners.add(listener);
  return () => walletListeners.delete(listener);
}

function updateWalletState(nextState: Partial<WalletState>) {
  walletState = { ...walletState, ...nextState };
  walletListeners.forEach((listener) => listener());
}

function handleConnectedPublicKey(publicKey: PhantomPublicKey | null) {
  if (publicKey) {
    updateWalletState({
      address: publicKey.toBase58(),
      isConnected: true,
      isConnecting: false,
      walletError: undefined,
    });
    return;
  }

  updateWalletState({
    address: undefined,
    isConnected: false,
    isConnecting: false,
  });
}

function handleDisconnect() {
  updateWalletState({
    address: undefined,
    isConnected: false,
    isConnecting: false,
  });
}

function initializePhantomEvents() {
  if (phantomEventsInitialized) {
    return;
  }

  const provider = getPhantomProvider();

  if (!provider) {
    return;
  }

  provider.on('connect', handleConnectedPublicKey);
  provider.on('accountChanged', handleConnectedPublicKey);
  provider.on('disconnect', handleDisconnect);
  phantomEventsInitialized = true;
}

function attemptEagerConnect() {
  const provider = getPhantomProvider();

  if (!provider || eagerConnectAttempted) {
    return;
  }

  eagerConnectAttempted = true;

  provider.connect({ onlyIfTrusted: true })
    .then((response) => handleConnectedPublicKey(response.publicKey))
    .catch(() => {
      // Silent fail: the user has not previously trusted this app in Phantom.
    });
}

function toUint8Array(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

type DecodedTransaction = web3.VersionedTransaction | web3.Transaction;

function decodeUnsignedTransaction(base64: string): DecodedTransaction {
  const bytes = toUint8Array(base64);
  
  // Try VersionedTransaction first (has version byte prefix)
  try {
    return web3.VersionedTransaction.deserialize(bytes);
  } catch {
    // Fallback to Legacy Transaction
    try {
      return web3.Transaction.from(bytes);
    } catch (error) {
      throw Object.assign(new Error(`Invalid unsigned transaction: ${getErrorMessage(error)}`), {
        code: 'send_failed',
      });
    }
  }
}

function mapPhantomError(error: unknown): { code: PhantomExecutionErrorCode; message: string } {
  const message = getErrorMessage(error) || 'Phantom execution failed';
  const lower = message.toLowerCase();

  if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('denied')) {
    return { code: 'user_rejected', message: 'El usuario rechazó la firma en Phantom.' };
  }

  if (lower.includes('account changed') || lower.includes('pubkey')) {
    return { code: 'account_changed', message: 'La cuenta cambió durante la firma.' };
  }

  if (lower.includes('disconnected') || lower.includes('not connected')) {
    return { code: 'phantom_not_connected', message: 'Phantom está desconectado.' };
  }

  if (lower.includes('blockhash') || lower.includes('expired')) {
    return { code: 'blockhash_expired', message: 'La transacción venció; vuelve a aprobar para regenerarla.' };
  }

  return { code: 'send_failed', message };
}

function throwWithCode(code: PhantomExecutionErrorCode, message: string): never {
  const error = new Error(message) as SignAndSendError;
  error.code = code;
  throw error;
}

export function useWallet() {
  const state = useSyncExternalStore(subscribeToWallet, getWalletSnapshot, getWalletSnapshot);
  const balancesQuery = useWalletBalances(state.address);
  const highlightBalances = getHighlightBalances(balancesQuery.data?.balances);
  const allocation = getAllocationFromBalances(balancesQuery.data?.balances);

  const connect = useCallback(async () => {
    updateWalletState({ walletError: undefined, isConnecting: true });

    try {
      const provider = getPhantomProvider();

      if (!provider) {
        throw new Error('Phantom wallet not detected. Please install Phantom from https://phantom.app/download');
      }

      initializePhantomEvents();
      const response = await provider.connect();
      handleConnectedPublicKey(response.publicKey);
    } catch (error) {
      console.error('Failed to connect to Phantom:', error);
      updateWalletState({
        walletError: getErrorMessage(error),
        isConnected: false,
        isConnecting: false,
        address: undefined,
      });
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      const provider = getPhantomProvider();

      if (provider) {
        await provider.disconnect();
      }

      updateWalletState({
        isConnected: false,
        address: undefined,
        walletError: undefined,
        isConnecting: false,
      });
    } catch (error) {
      console.error('Failed to disconnect from Phantom:', error);
      updateWalletState({ walletError: getErrorMessage(error), isConnecting: false });
    }
  }, []);

  const signAndSendPreparedTransaction = useCallback(async (
    unsignedTxBase64: string,
    expectedUserAddress?: string
  ): Promise<PhantomExecutionResult> => {
    const provider = getPhantomProvider();

    if (!provider) {
      throwWithCode('phantom_not_detected', 'Phantom wallet no detectada. Instálala y recarga la página.');
    }

    if (!state.isConnected || !state.address) {
      throwWithCode('phantom_not_connected', 'Phantom está desconectado.');
    }

    const connectedAddress = provider.publicKey?.toBase58() ?? state.address;
    if (!connectedAddress) {
      throwWithCode('phantom_not_connected', 'No se detectó cuenta conectada en Phantom.');
    }

    if (expectedUserAddress && connectedAddress !== expectedUserAddress) {
      throwWithCode('wallet_mismatch', 'El wallet conectado no coincide con la propuesta.');
    }

    const tx = decodeUnsignedTransaction(unsignedTxBase64);
    const isVersioned = tx instanceof web3.VersionedTransaction;
    
    console.log('[useWallet] Transaction type:', isVersioned ? 'VersionedTransaction' : 'LegacyTransaction');
    console.log('[useWallet] Transaction details:', {
      isVersioned,
      numSignatures: isVersioned ? (tx as web3.VersionedTransaction).signatures.length : (tx as web3.Transaction).signatures.length,
      // @ts-ignore
      numInstructions: isVersioned ? (tx as web3.VersionedTransaction).message.compiledInstructions?.length : (tx as web3.Transaction).instructions?.length,
    });

    try {
      let signResult;
      
      if (isVersioned) {
        // VersionedTransaction - use signAndSendTransaction directly
        console.log('[useWallet] Signing VersionedTransaction...');
        signResult = await provider.signAndSendTransaction(tx as web3.VersionedTransaction);
      } else {
        // Legacy Transaction - Phantom also supports this via signAndSendTransaction
        console.log('[useWallet] Signing LegacyTransaction...');
        signResult = await provider.signAndSendTransaction(tx as web3.Transaction);
      }
      
      const signature = typeof signResult === 'string' ? signResult : signResult?.signature;

      if (!signature) {
        throwWithCode('send_failed', 'Phantom no devolvió una firma válida.');
      }

      const currentAddress = provider.publicKey?.toBase58() ?? connectedAddress;
      if (expectedUserAddress && currentAddress !== expectedUserAddress) {
        throwWithCode('account_changed', 'La cuenta cambió durante la firma.');
      }

      return { tx_signature: signature };
    } catch (error: any) {
      console.error('[useWallet] signAndSendTransaction error:', error);
      console.error('[useWallet] Error details:', {
        message: error?.message,
        code: error?.code,
        name: error?.name,
        stack: error?.stack,
        raw: JSON.stringify(error, Object.getOwnPropertyNames(error)),
      });
      const mapped = mapPhantomError(error);
      throwWithCode(mapped.code, mapped.message);
    }
  }, [state.isConnected, state.address]);

  useEffect(() => {
    initializePhantomEvents();
    attemptEagerConnect();
  }, []);

  return {
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    isDisconnecting: false,
    address: state.address,
    connect,
    disconnect,
    exportPrivateKey: undefined as undefined | (() => Promise<void>),
    signAndSendPreparedTransaction,
    walletError: state.walletError,
    balances: balancesQuery.data,
    allocation,
    highlightBalances,
    refreshBalances: balancesQuery.refetch,
    isBalancesLoading: balancesQuery.isLoading,
    balancesError: balancesQuery.error,
  };
}
