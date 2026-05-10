import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPhantomProvider, type PhantomPublicKey } from '@/types/phantom';
import { getAllocationFromBalances, getHighlightBalances } from '@/lib/walletBalances';
import { useWalletBalances } from './useWalletBalances';

type WalletState = {
  isConnected: boolean;
  isConnecting: boolean;
  address: string | undefined;
  walletError: string | undefined;
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
    walletError: state.walletError,
    balances: balancesQuery.data,
    isBalancesLoading: balancesQuery.isLoading,
    balancesError: balancesQuery.error,
    highlightBalances,
    allocation,
    refreshBalances: balancesQuery.refetch,
  };
}
