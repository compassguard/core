import { AddressType, useConnect, useDisconnect, usePhantom } from '@phantom/react-sdk';
import { useWalletBalances } from './useWalletBalances';

const hasEmbeddedProviders = Boolean(process.env.NEXT_PUBLIC_PHANTOM_APP_ID);

function getErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export function useWallet() {
  const { isConnected, isConnecting, isLoading, addresses, errors } = usePhantom();
  const { connect: sdkConnect, error: connectError } = useConnect();
  const { disconnect: sdkDisconnect, isDisconnecting, error: disconnectError } = useDisconnect();

  const address = addresses.find((item) => item.addressType === AddressType.solana)?.address;
  const balancesQuery = useWalletBalances(address);

  // Connect function - uses google provider if embedded, otherwise phantom extension
  const connect = () => {
    if (hasEmbeddedProviders) {
      return sdkConnect({ provider: 'google' });
    }
    // Standard Phantom wallet connection via extension
    return sdkConnect({ provider: 'phantom' });
  };

  return {
    isConnected: Boolean(isConnected && address),
    isConnecting: isConnecting || isLoading,
    isDisconnecting,
    address,
    connect,
    disconnect: sdkDisconnect,
    exportPrivateKey: undefined as undefined | (() => Promise<void>),
    walletError: getErrorMessage(errors.connect ?? connectError ?? disconnectError),
    balances: balancesQuery.data,
    isBalancesLoading: balancesQuery.isLoading,
    balancesError: balancesQuery.error,
    hasEmbeddedProviders,
  };
}
