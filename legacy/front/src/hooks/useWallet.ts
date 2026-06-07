import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { web3 } from '@coral-xyz/anchor';
import { getAuthToken } from '@dynamic-labs/sdk-react-core';
import { createDynamicAppSession, logoutAppSession } from '@/lib/api/client';
import { useDynamicWalletRuntime } from '@/providers/dynamicWalletRuntime';
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
  isResolved: boolean;
  address: string | undefined;
  walletError: string | undefined;
};

type WalletExecutionErrorCode = PhantomExecutionErrorCode | 'wallet_not_connected';

type SignAndSendError = Error & {
  code?: WalletExecutionErrorCode;
};

const INITIAL_WALLET_STATE: WalletState = {
  isConnected: false,
  isConnecting: false,
  isResolved: false,
  address: undefined,
  walletError: undefined,
};

let walletState = INITIAL_WALLET_STATE;
const walletListeners = new Set<() => void>();
let phantomEventsInitialized = false;
let eagerConnectAttempted = false;
let lastDynamicAppSessionKey: string | null = null;

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
      isResolved: true,
      walletError: undefined,
    });
    return;
  }

  updateWalletState({
    address: undefined,
    isConnected: false,
    isConnecting: false,
    isResolved: true,
  });
}

function handleDisconnect() {
  updateWalletState({
    address: undefined,
    isConnected: false,
    isConnecting: false,
    isResolved: true,
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
    if (!provider) {
      updateWalletState({ isResolved: true });
    }
    return;
  }

  eagerConnectAttempted = true;

  provider.connect({ onlyIfTrusted: true })
    .then((response) => handleConnectedPublicKey(response.publicKey))
    .catch(() => {
      updateWalletState({ isResolved: true });
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

  console.log('[mapPhantomError] Mapping error:', { message, lower });

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

  // Insufficient funds errors
  if (lower.includes('insufficient') || lower.includes('not enough') || lower.includes('0x1')) {
    // Try to extract more specific info from the error
    const insufficientMatch = message.match(/insufficient.*?(\d+\.?\d*)/i);
    if (insufficientMatch) {
      return { code: 'send_failed', message: `Fondos insuficientes. ${message}` };
    }
    return { code: 'send_failed', message: 'Fondos insuficientes para completar esta transacción.' };
  }

  // Custom program errors (like 0x1 which often means insufficient funds in token programs)
  if (lower.includes('custom program error') || lower.includes('program error')) {
    return { code: 'send_failed', message: `Error del programa: ${message}` };
  }

  return { code: 'send_failed', message };
}

function throwWithCode(code: WalletExecutionErrorCode, message: string): never {
  const error = new Error(message) as SignAndSendError;
  error.code = code;
  throw error;
}

function safeGetDynamicAuthToken(): string | undefined {
  try {
    return getAuthToken();
  } catch (error) {
    console.warn('[useWallet] Dynamic auth token is unavailable:', error);
    return undefined;
  }
}

export function useWallet() {
  const dynamicWallet = useDynamicWalletRuntime();
  const state = useSyncExternalStore(subscribeToWallet, getWalletSnapshot, getWalletSnapshot);
  const usesDynamicWallet = Boolean(dynamicWallet?.isEnabled);
  const activeAddress = usesDynamicWallet ? dynamicWallet?.address : state.address;
  const balancesQuery = useWalletBalances(activeAddress);
  const highlightBalances = getHighlightBalances(balancesQuery.data?.balances);
  const allocation = getAllocationFromBalances(balancesQuery.data?.balances);

  const connect = useCallback(async () => {
    if (usesDynamicWallet && dynamicWallet) {
      await dynamicWallet.connect();
      return;
    }

    updateWalletState({ walletError: undefined, isConnecting: true, isResolved: true });

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
        isResolved: true,
        address: undefined,
      });
    }
  }, [dynamicWallet, usesDynamicWallet]);

  const disconnect = useCallback(async () => {
    if (usesDynamicWallet && dynamicWallet) {
      await logoutAppSession().catch((error) => {
        console.warn('[useWallet] Failed to clear app session during Dynamic logout:', error);
      });
      lastDynamicAppSessionKey = null;
      updateWalletState({
        address: undefined,
        isConnected: false,
        isConnecting: false,
        isResolved: true,
        walletError: undefined,
      });
      await dynamicWallet.disconnect();
      return;
    }

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
        isResolved: true,
      });
    } catch (error) {
      console.error('Failed to disconnect from Phantom:', error);
      updateWalletState({ walletError: getErrorMessage(error), isConnecting: false, isResolved: true });
    }
  }, [dynamicWallet, usesDynamicWallet]);

  const signAndSendPreparedTransaction = useCallback(async (
    unsignedTxBase64: string,
    expectedUserAddress?: string
  ): Promise<PhantomExecutionResult> => {
    const provider = usesDynamicWallet ? null : getPhantomProvider();

    if (usesDynamicWallet && !dynamicWallet) {
      throwWithCode('wallet_not_connected', 'No hay wallet conectada.');
    }

    if (!usesDynamicWallet && !provider) {
      throwWithCode('phantom_not_detected', 'Phantom wallet no detectada. Instálala y recarga la página.');
    }

    if (usesDynamicWallet && (!dynamicWallet?.isConnected || !dynamicWallet.address)) {
      throwWithCode('wallet_not_connected', 'La wallet Dynamic está desconectada.');
    }

    if (!usesDynamicWallet && (!state.isConnected || !state.address)) {
      throwWithCode('phantom_not_connected', 'Phantom está desconectado.');
    }

    const connectedAddress = usesDynamicWallet
      ? dynamicWallet?.address
      : provider?.publicKey?.toBase58() ?? state.address;
    if (!connectedAddress) {
      throwWithCode('wallet_not_connected', 'No se detectó cuenta conectada.');
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
      numInstructions: isVersioned
        ? (tx as web3.VersionedTransaction).message.compiledInstructions.length
        : (tx as web3.Transaction).instructions.length,
    });

    try {
      // Pre-simulate to get better error messages before Phantom shows its generic "Unexpected error"
      const connection = new web3.Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        'confirmed'
      );
      
      console.log('[useWallet] Pre-simulating transaction...');
      try {
        const simResult = await connection.simulateTransaction(tx as web3.VersionedTransaction, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        
        if (simResult.value.err) {
          console.error('[useWallet] Simulation failed:', simResult.value.err);
          console.error('[useWallet] Simulation logs:', simResult.value.logs);
          
          // Parse simulation error for better messages
          const logs = simResult.value.logs?.join('\n') || '';
          const errStr = JSON.stringify(simResult.value.err);
          
          // Check for insufficient funds
          if (logs.includes('insufficient') || logs.includes('Insufficient') || 
              logs.includes('Transfer: insufficient lamports') ||
              errStr.includes('InsufficientFunds') || errStr.includes('0x1')) {
            throwWithCode('send_failed', 'Fondos insuficientes. No tenés suficiente balance para completar este swap.');
          }
          
          // Check for token account issues
          if (logs.includes('TokenAccountNotFoundError') || logs.includes('AccountNotFound')) {
            throwWithCode('send_failed', 'No se encontró la cuenta del token. Puede que no tengas este token en tu wallet.');
          }
          
          // Generic simulation failure with logs
          const lastLog = simResult.value.logs?.slice(-3).join(' | ') || errStr;
          throwWithCode('send_failed', `La transacción falló en simulación: ${lastLog}`);
        }
        console.log('[useWallet] Simulation successful, proceeding to sign...');
      } catch (simError: unknown) {
        // If simulation itself throws, check if it's our throwWithCode or a network error
        const errorLike = simError as { code?: string; message?: string };
        if (errorLike.code === 'send_failed') {
          throw simError; // Re-throw our formatted error
        }
        console.warn('[useWallet] Simulation check failed, proceeding anyway:', errorLike.message);
        // Continue to Phantom - let it handle the error
      }
      
      let signResult;
      
      if (usesDynamicWallet && dynamicWallet) {
        console.log('[useWallet] Signing with Dynamic Solana wallet...');
        signResult = await dynamicWallet.signAndSendTransaction(tx);
      } else if (isVersioned) {
        // VersionedTransaction - use signAndSendTransaction directly
        console.log('[useWallet] Signing VersionedTransaction...');
        signResult = await provider!.signAndSendTransaction(tx as web3.VersionedTransaction);
      } else {
        // Legacy Transaction - Phantom also supports this via signAndSendTransaction
        console.log('[useWallet] Signing LegacyTransaction...');
        signResult = await provider!.signAndSendTransaction(tx as web3.Transaction);
      }
      
      const signature = typeof signResult === 'string' ? signResult : signResult?.signature;

      if (!signature) {
        throwWithCode('send_failed', 'La wallet no devolvió una firma válida.');
      }

      const currentAddress = usesDynamicWallet
        ? dynamicWallet?.address
        : provider?.publicKey?.toBase58() ?? connectedAddress;
      if (expectedUserAddress && currentAddress !== expectedUserAddress) {
        throwWithCode('account_changed', 'La cuenta cambió durante la firma.');
      }

      return { tx_signature: signature };
    } catch (error: unknown) {
      console.error('[useWallet] signAndSendTransaction error:', error);
      const errorObject = error && typeof error === 'object' ? error : null;
      console.error('[useWallet] Error details:', {
        message: getErrorMessage(error),
        code: errorObject && 'code' in errorObject ? errorObject.code : undefined,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        raw: errorObject ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error),
      });
      const mapped = mapPhantomError(error);
      throwWithCode(mapped.code, mapped.message);
    }
  }, [
    dynamicWallet,
    state.address,
    state.isConnected,
    usesDynamicWallet,
  ]);

  useEffect(() => {
    if (!usesDynamicWallet) return;
    if (!dynamicWallet?.isResolved) return;

    if (!dynamicWallet.address || !dynamicWallet.walletType) {
      if (lastDynamicAppSessionKey) {
        lastDynamicAppSessionKey = null;
        void logoutAppSession().catch((error) => {
          console.warn('[useWallet] Failed to clear app session after Dynamic wallet disconnect:', error);
        });
      }
      return;
    }

    const sessionKey = [
      dynamicWallet.dynamicUserId || 'anonymous-dynamic-user',
      dynamicWallet.address,
      dynamicWallet.walletType,
      dynamicWallet.walletProvider || 'unknown-provider',
    ].join(':');
    if (lastDynamicAppSessionKey === sessionKey) return;
    lastDynamicAppSessionKey = sessionKey;

    void createDynamicAppSession({
      dynamicUserId: dynamicWallet.dynamicUserId,
      walletAddress: dynamicWallet.address,
      walletType: dynamicWallet.walletType,
      walletProvider: dynamicWallet.walletProvider,
      dynamicAuthToken: safeGetDynamicAuthToken(),
    }).then(() => {
      updateWalletState({ walletError: undefined });
    }).catch((error) => {
      lastDynamicAppSessionKey = null;
      updateWalletState({ walletError: getErrorMessage(error) || 'No se pudo crear la sesión de Compass.' });
      console.error('[useWallet] Failed to create app session from Dynamic wallet:', error);
    });
  }, [
    dynamicWallet?.address,
    dynamicWallet?.dynamicUserId,
    dynamicWallet?.isResolved,
    dynamicWallet?.walletProvider,
    dynamicWallet?.walletType,
    usesDynamicWallet,
  ]);

  useEffect(() => {
    if (usesDynamicWallet) return;
    initializePhantomEvents();
    attemptEagerConnect();
  }, [usesDynamicWallet]);

  return {
    isAuthenticated: usesDynamicWallet ? Boolean(dynamicWallet?.address) : state.isConnected,
    isConnected: usesDynamicWallet ? Boolean(dynamicWallet?.isConnected) : state.isConnected,
    isConnecting: usesDynamicWallet ? Boolean(dynamicWallet?.isConnecting) : state.isConnecting,
    isDisconnecting: false,
    isResolved: usesDynamicWallet ? Boolean(dynamicWallet?.isResolved) : state.isResolved,
    address: activeAddress,
    walletType: usesDynamicWallet ? dynamicWallet?.walletType : 'external' as const,
    walletProvider: usesDynamicWallet ? dynamicWallet?.walletProvider : 'phantom',
    dynamicUserId: usesDynamicWallet ? dynamicWallet?.dynamicUserId : undefined,
    authStatus: usesDynamicWallet
      ? dynamicWallet?.address
        ? 'verified' as const
        : 'unauthenticated' as const
      : state.isConnected
        ? 'connected' as const
        : 'unauthenticated' as const,
    connect,
    disconnect,
    exportPrivateKey: dynamicWallet?.exportWallet,
    exportWallet: dynamicWallet?.exportWallet,
    signAndSendPreparedTransaction,
    walletError: usesDynamicWallet ? dynamicWallet?.walletError : state.walletError,
    balances: balancesQuery.data,
    allocation,
    highlightBalances,
    refreshBalances: balancesQuery.refetch,
    isBalancesLoading: balancesQuery.isLoading,
    balancesError: balancesQuery.error,
  };
}
