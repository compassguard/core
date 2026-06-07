'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DynamicContextProvider,
  useDynamicContext,
  useDynamicWaas,
  useIsLoggedIn,
  useRefreshUser,
  useUserWallets,
} from '@dynamic-labs/sdk-react-core';
import { ChainEnum } from '@dynamic-labs/sdk-api-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import {
  isSolanaWallet,
  SolanaWalletConnectors,
  SolanaWalletConnectorsWithConfig,
} from '@dynamic-labs/solana';
import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import type { AppWalletType } from '@/types/wallet';
import {
  DynamicWalletRuntimeContext,
  type DynamicWalletRuntime,
} from './dynamicWalletRuntime';

type DynamicUserLike = {
  id?: string;
  userId?: string;
  verifiedCredentials?: Array<{
    address?: string;
    publicIdentifier?: string;
    walletName?: string;
    walletProvider?: string;
  }>;
};

type DynamicWalletLike = {
  address?: string;
  connector?: {
    connectedChain?: string;
    isEmbeddedWallet?: boolean;
    key?: string;
    name?: string;
  };
  getSigner?: () => Promise<{
    signAndSendTransaction: (
      transaction: Transaction | VersionedTransaction,
    ) => Promise<string | { signature?: string }>;
  }>;
};

function getWalletConnectors() {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  const solanaConnectors = rpcUrl
    ? SolanaWalletConnectorsWithConfig({
        commitment: 'confirmed',
        customRpcUrls: {
          solana: [rpcUrl],
        },
      })
    : SolanaWalletConnectors;

  return [
    solanaConnectors,
    EthereumWalletConnectors,
  ];
}

function getDynamicUserId(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') return undefined;
  const dynamicUser = user as DynamicUserLike;
  return dynamicUser.userId || dynamicUser.id;
}

function toDynamicWalletLike(wallet: unknown): DynamicWalletLike | undefined {
  if (!wallet || typeof wallet !== 'object') return undefined;
  return wallet as DynamicWalletLike;
}

function getErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function DynamicWalletRuntimeBridge({ children }: { children: ReactNode }) {
  const {
    handleLogOut,
    primaryWallet,
    sdkHasLoaded,
    setShowAuthFlow,
    setShowDynamicUserProfile,
    showAuthFlow,
    user,
  } = useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const userWallets = useUserWallets();
  const refreshUser = useRefreshUser();
  const {
    createWalletAccount,
    dynamicWaasIsEnabled,
  } = useDynamicWaas();
  const embeddedWalletCreateAttemptKeyRef = useRef<string | null>(null);
  const [isProvisioningSolanaWallet, setIsProvisioningSolanaWallet] = useState(false);
  const [walletProvisioningError, setWalletProvisioningError] = useState<string | undefined>();

  const activeSolanaWallet = useMemo(() => {
    if (primaryWallet && isSolanaWallet(primaryWallet)) {
      return toDynamicWalletLike(primaryWallet);
    }

    return toDynamicWalletLike(userWallets.find((wallet) => isSolanaWallet(wallet)));
  }, [primaryWallet, userWallets]);

  const walletType: AppWalletType | undefined = activeSolanaWallet?.connector?.isEmbeddedWallet
    ? 'embedded'
    : activeSolanaWallet?.address
      ? 'external'
      : undefined;

  const walletProvider =
    activeSolanaWallet?.connector?.name || activeSolanaWallet?.connector?.key || undefined;
  const dynamicUserId = getDynamicUserId(user);

  useEffect(() => {
    if (!isLoggedIn) {
      embeddedWalletCreateAttemptKeyRef.current = null;
      setWalletProvisioningError(undefined);
      return;
    }

    if (!sdkHasLoaded || !dynamicWaasIsEnabled || activeSolanaWallet?.address || isProvisioningSolanaWallet) {
      return;
    }

    const walletFingerprint = userWallets
      .map((wallet) => {
        const walletLike = toDynamicWalletLike(wallet);
        return [
          walletLike?.address || 'no-address',
          walletLike?.connector?.connectedChain || 'unknown-chain',
          walletLike?.connector?.key || 'unknown-connector',
        ].join('/');
      })
      .sort()
      .join('|');
    const attemptKey = [dynamicUserId || 'dynamic-email-user', walletFingerprint || 'no-wallets'].join(':');
    if (embeddedWalletCreateAttemptKeyRef.current === attemptKey) {
      return;
    }

    let isMounted = true;
    embeddedWalletCreateAttemptKeyRef.current = attemptKey;
    setWalletProvisioningError(undefined);
    setIsProvisioningSolanaWallet(true);

    const provisioningTimer = window.setTimeout(() => {
      createWalletAccount([ChainEnum.Sol], undefined, undefined, { skipCloseAuthFlow: false })
        .then(() => refreshUser())
        .catch((error) => {
          if (!isMounted) return;
          const message = getErrorMessage(error) || 'No se pudo crear la embedded wallet Solana.';
          setWalletProvisioningError(message);
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[DynamicWalletProvider] Failed to provision Solana WaaS wallet:', error);
          }
        })
        .finally(() => {
          if (isMounted) {
            setIsProvisioningSolanaWallet(false);
          }
        });
    }, 700);

    return () => {
      isMounted = false;
      window.clearTimeout(provisioningTimer);
    };
  }, [
    activeSolanaWallet?.address,
    createWalletAccount,
    dynamicUserId,
    dynamicWaasIsEnabled,
    isLoggedIn,
    isProvisioningSolanaWallet,
    refreshUser,
    sdkHasLoaded,
    userWallets,
  ]);

  const connect = useCallback(async () => {
    setShowAuthFlow(true);
  }, [setShowAuthFlow]);

  const disconnect = useCallback(async () => {
    setShowAuthFlow(false);
    await handleLogOut();
  }, [handleLogOut, setShowAuthFlow]);

  const signAndSendTransaction = useCallback(
    async (transaction: Transaction | VersionedTransaction): Promise<string> => {
      if (!activeSolanaWallet?.getSigner) {
        throw new Error('No Solana signer available for the active Dynamic wallet.');
      }

      const signer = await activeSolanaWallet.getSigner();
      const result = await signer.signAndSendTransaction(transaction);
      const signature = typeof result === 'string' ? result : result.signature;

      if (!signature) {
        throw new Error('Dynamic wallet did not return a transaction signature.');
      }

      return signature;
    },
    [activeSolanaWallet],
  );

  const exportWallet = useMemo(() => {
    if (walletType !== 'embedded') return undefined;

    return async () => {
      setShowDynamicUserProfile(true);
    };
  }, [setShowDynamicUserProfile, walletType]);

  const runtime = useMemo<DynamicWalletRuntime>(() => ({
    isEnabled: true,
    isResolved: sdkHasLoaded,
    isConnected: Boolean(activeSolanaWallet?.address),
    isConnecting: (Boolean(showAuthFlow) || isProvisioningSolanaWallet || isLoggedIn) && !activeSolanaWallet?.address,
    address: activeSolanaWallet?.address,
    walletType,
    walletProvider,
    dynamicUserId,
    walletError: walletProvisioningError,
    connect,
    disconnect,
    signAndSendTransaction,
    exportWallet,
  }), [
    activeSolanaWallet?.address,
    connect,
    disconnect,
    exportWallet,
    dynamicUserId,
    isProvisioningSolanaWallet,
    isLoggedIn,
    sdkHasLoaded,
    showAuthFlow,
    signAndSendTransaction,
    walletProvider,
    walletProvisioningError,
    walletType,
  ]);

  return (
    <DynamicWalletRuntimeContext.Provider value={runtime}>
      {children}
    </DynamicWalletRuntimeContext.Provider>
  );
}

export function DynamicWalletProvider({ children }: { children: ReactNode }) {
  const buildTimeEnvironmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID?.trim();
  const [runtimeEnvironmentId, setRuntimeEnvironmentId] = useState<string | undefined>(buildTimeEnvironmentId);
  const [hasResolvedRuntimeConfig, setHasResolvedRuntimeConfig] = useState(Boolean(buildTimeEnvironmentId));

  useEffect(() => {
    if (buildTimeEnvironmentId) return;

    let isMounted = true;

    fetch('/api/config/dynamic', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then((response) => (response.ok ? response.json() : {}))
      .then((config: { environment_id?: unknown }) => {
        if (!isMounted) return;
        const environmentId = typeof config.environment_id === 'string'
          ? config.environment_id.trim()
          : undefined;
        setRuntimeEnvironmentId(environmentId || undefined);
      })
      .catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[DynamicWalletProvider] Failed to load Dynamic runtime config:', error);
        }
      })
      .finally(() => {
        if (isMounted) {
          setHasResolvedRuntimeConfig(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [buildTimeEnvironmentId]);

  if (!runtimeEnvironmentId) {
    if (hasResolvedRuntimeConfig && process.env.NODE_ENV !== 'production') {
      console.warn(
        '[DynamicWalletProvider] Dynamic environment id is not configured; Dynamic wallet auth is disabled.',
      );
    }

    return (
      <DynamicWalletRuntimeContext.Provider value={null}>
        {children}
      </DynamicWalletRuntimeContext.Provider>
    );
  }

  return (
    <DynamicContextProvider
      settings={{
        environmentId: runtimeEnvironmentId,
        newToWeb3WalletChainMap: {
          primary_chain: 'solana',
          wallets: {
            solana: 'dynamicwaas',
          },
        },
        walletConnectors: getWalletConnectors(),
        walletsFilter: (wallets) => wallets.filter((wallet) => {
          const connector = wallet.walletConnector;
          return connector.connectedChain === 'SOL';
        }),
      }}
    >
      <DynamicWalletRuntimeBridge>{children}</DynamicWalletRuntimeBridge>
    </DynamicContextProvider>
  );
}
