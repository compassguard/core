import { Loader2, LogOut, KeyRound, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { truncateAddress } from '@/lib/format';
import { useWallet } from '@/hooks/useWallet';
import { useChatStore } from '@/stores/chatStore';

export function ConnectButton() {
  const wallet = useWallet();
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

  if (!wallet.isConnected) {
    const isPhantomNotDetected = wallet.walletError?.toLowerCase().includes('not detected');

    return (
      <div className="flex flex-col items-end gap-1">
        <Button onClick={connect} disabled={isBusy || wallet.isConnecting} className="rounded-xl bg-primary px-5 text-primary-foreground hover:bg-primary/90">
          {isBusy || wallet.isConnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Connect Phantom
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
