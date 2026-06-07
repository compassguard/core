import { Loader2, LogOut, KeyRound, Copy } from 'lucide-react';
import {
  DynamicConnectButton,
  useDynamicContext,
  useDynamicWaas,
  useIsLoggedIn,
  useRefreshUser,
  useUserWallets,
} from '@dynamic-labs/sdk-react-core';
import { ChainEnum } from '@dynamic-labs/sdk-api-core';
import { isSolanaWallet } from '@dynamic-labs/solana';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { truncateAddress } from '@/lib/format';
import { useWallet } from '@/hooks/useWallet';
import { useDynamicWalletRuntime } from '@/providers/dynamicWalletRuntime';
import { useChatStore } from '@/stores/chatStore';

function DynamicWidgetPanel({
  isBusy,
  isProvisioningWallet,
  onDisconnect,
  walletError,
}: {
  isBusy: boolean;
  isProvisioningWallet: boolean;
  onDisconnect: () => Promise<void>;
  walletError?: string;
}) {
  const { sdkHasLoaded, userWithMissingInfo } = useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const userWallets = useUserWallets();
  const refreshUser = useRefreshUser();
  const {
    createWalletAccount,
    dynamicWaasIsEnabled,
  } = useDynamicWaas();
  const [embeddedWalletError, setEmbeddedWalletError] = useState<string | undefined>();
  const [isCreatingSolanaWallet, setIsCreatingSolanaWallet] = useState(false);

  async function createSolanaEmbeddedWallet() {
    setEmbeddedWalletError(undefined);
    setIsCreatingSolanaWallet(true);
    try {
      await createWalletAccount([ChainEnum.Sol], undefined, undefined, { skipCloseAuthFlow: false });
      await refreshUser();
    } catch (error) {
      setEmbeddedWalletError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingSolanaWallet(false);
    }
  }

  const hasSolanaWallet = userWallets.some((wallet) => isSolanaWallet(wallet));
  const canCreateEmbeddedWallet = sdkHasLoaded && isLoggedIn && dynamicWaasIsEnabled && !hasSolanaWallet;

  const missingFields = userWithMissingInfo?.missingFields ?? [];

  return (
    <div className="flex flex-col items-end gap-1">
      {!isLoggedIn ? (
        <DynamicConnectButton
          buttonClassName="rounded-xl bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          buttonContainerClassName="flex justify-end"
        >
          Connect with Dynamic
        </DynamicConnectButton>
      ) : (
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-outline bg-surface px-3 py-1.5 text-sm font-medium text-on-surface">
            Dynamic logged in
          </span>
          <Button
            type="button"
            onClick={onDisconnect}
            disabled={isBusy}
            variant="outline"
            size="sm"
            className="rounded-xl"
          >
            {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Logout
          </Button>
        </div>
      )}
      <p className="text-right text-[10px] text-on-surface-variant">
        Dynamic SDK: {sdkHasLoaded ? 'ready' : 'loading'} · logged: {isLoggedIn ? 'yes' : 'no'} · wallets: {userWallets.length}
      </p>
      {missingFields.length > 0 ? (
        <div className="max-w-72 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-right text-xs text-amber-900">
          Dynamic requiere completar campos de perfil: {missingFields.map((field) => field.label || field.name).join(', ')}.
        </div>
      ) : null}
      {canCreateEmbeddedWallet && !(embeddedWalletError || walletError) ? (
        <div className="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-xs text-on-surface-variant">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Creando wallet Solana...
        </div>
      ) : null}
      {canCreateEmbeddedWallet && (embeddedWalletError || walletError) ? (
        <Button
          type="button"
          onClick={createSolanaEmbeddedWallet}
          disabled={isCreatingSolanaWallet || isProvisioningWallet}
          variant="outline"
          size="sm"
          className="rounded-xl"
        >
          {isCreatingSolanaWallet || isProvisioningWallet ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Retry Solana wallet
        </Button>
      ) : null}
      {embeddedWalletError ? (
        <div className="max-w-64 text-right text-xs text-error-text">
          <p>{embeddedWalletError}</p>
        </div>
      ) : null}
      {walletError ? (
        <div className="max-w-64 text-right text-xs text-error-text">
          <p>{walletError}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectButton() {
  const wallet = useWallet();
  const dynamicWallet = useDynamicWalletRuntime();
  const clearChat = useChatStore((state) => state.clearChat);
  const [isBusy, setIsBusy] = useState(false);

  async function connect() {
    setIsBusy(true);
    try {
      await wallet.connect?.();
    } finally {
      setIsBusy(false);
    }
  }

  async function disconnect() {
    setIsBusy(true);
    try {
      await wallet.disconnect?.();
      clearChat();
    } finally {
      setIsBusy(false);
    }
  }

  if (dynamicWallet && !wallet.isConnected) {
    return (
      <DynamicWidgetPanel
        isBusy={isBusy}
        isProvisioningWallet={wallet.isConnecting}
        onDisconnect={disconnect}
        walletError={wallet.walletError}
      />
    );
  }

  if (!wallet.isConnected) {
    const isPhantomNotDetected = wallet.walletError?.toLowerCase().includes('phantom') &&
      wallet.walletError?.toLowerCase().includes('not detected');

    return (
      <div className="flex flex-col items-end gap-1">
        <Button onClick={connect} disabled={isBusy || wallet.isConnecting} className="rounded-xl bg-primary px-5 text-primary-foreground hover:bg-primary/90">
          {isBusy || wallet.isConnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Connect or create wallet
        </Button>
        {wallet.walletError ? (
          <div className="max-w-64 text-right text-xs text-error-text">
            <p>{wallet.walletError}</p>
            {isPhantomNotDetected ? (
              <a
                href="https://phantom.app/download"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block underline hover:text-error-text/80"
              >
                Download Phantom
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-outline bg-surface px-3 py-1.5 shadow-sm">
      <span className="h-2 w-2 rounded-full bg-success" />
      {wallet.walletType ? (
        <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
          {wallet.walletType === 'embedded' ? 'Embedded' : 'External'}
        </span>
      ) : null}
      <span className="font-mono text-sm text-on-surface">{truncateAddress(wallet.address)}</span>
      <button
        type="button"
        className="rounded-full p-1 text-on-surface-variant hover:bg-surface-hover hover:text-on-surface"
        onClick={() => wallet.address && navigator.clipboard?.writeText(wallet.address)}
        aria-label="Copy address"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      {wallet.exportPrivateKey ? (
        <button
          type="button"
          className="rounded-full p-1 text-on-surface-variant hover:bg-surface-hover hover:text-on-surface"
          onClick={() => wallet.exportPrivateKey?.()}
          aria-label="Export private key"
        >
          <KeyRound className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        className="rounded-full p-1 text-on-surface-variant hover:bg-surface-hover hover:text-on-surface"
        onClick={disconnect}
        aria-label="Disconnect"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
