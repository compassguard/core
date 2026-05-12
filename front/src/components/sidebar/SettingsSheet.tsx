import { X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWallet } from '@/hooks/useWallet';

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const threshold = useSettingsStore((state) => state.autoConfirmThresholdUsd);
  const setThreshold = useSettingsStore((state) => state.setAutoConfirmThresholdUsd);
  const riskWarningsEnabled = useSettingsStore((state) => state.riskWarningsEnabled);
  const setRiskWarningsEnabled = useSettingsStore((state) => state.setRiskWarningsEnabled);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/20 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-outline bg-surface p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-on-surface">Settings</h2>
          <button onClick={onClose} className="rounded-full p-2 text-on-surface-variant hover:bg-surface-hover">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6">
          <section>
            <label className="text-sm font-semibold text-on-surface">Auto-confirm threshold</label>
            <p className="mt-1 text-sm text-on-surface-variant">Backend uses this value to decide auto vs manual confirmation.</p>
            <input
              type="range"
              min={0}
              max={500}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              className="mt-4 w-full"
            />
            <p className="mt-2 text-sm font-semibold text-primary">${threshold}</p>
          </section>

          <section className="rounded-2xl border border-outline p-4">
            <p className="text-sm font-semibold text-on-surface">Network</p>
            <p className="mt-1 text-sm text-on-surface-variant">Mainnet (read-only for hackathon)</p>
          </section>

          <section className="flex items-center justify-between rounded-2xl border border-outline p-4">
            <div>
              <p className="text-sm font-semibold text-on-surface">Risk warnings</p>
              <p className="text-sm text-on-surface-variant">Show warning banners from the agent.</p>
            </div>
            <input type="checkbox" checked={riskWarningsEnabled} onChange={(event) => setRiskWarningsEnabled(event.target.checked)} />
          </section>

          <section className="rounded-2xl border border-outline p-4">
            <p className="text-sm font-semibold text-on-surface">Account</p>
            <p className="mt-2 break-all font-mono text-xs text-on-surface-variant">{wallet.address ?? 'Not connected'}</p>
            <div className="mt-4 flex gap-2">
              {wallet.exportPrivateKey ? (
                <button onClick={() => wallet.exportPrivateKey?.()} className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-on-primary">
                  Export private key
                </button>
              ) : null}
              <button onClick={() => wallet.disconnect?.()} className="rounded-xl border border-outline px-3 py-2 text-sm font-semibold text-on-surface">
                Disconnect
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
