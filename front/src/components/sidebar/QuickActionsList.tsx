import { Clock, Headphones, Link2, Settings, Shield } from 'lucide-react';

const actions = [
  { label: 'History', icon: Clock },
  { label: 'Security', icon: Shield },
  { label: 'Connections', icon: Link2 },
  { label: 'Settings', icon: Settings },
  { label: 'Support', icon: Headphones },
];

export function QuickActionsList({ onSettings }: { onSettings?: () => void }) {
  return (
    <div className="rounded-3xl border border-outline bg-surface p-4 shadow-sm">
      <p className="mb-3 px-1 text-sm font-semibold text-on-surface">Quick Actions</p>
      <div className="space-y-1">
        {actions.map(({ label, icon: Icon }) => (
          <button
            key={label}
            onClick={label === 'Settings' ? onSettings : undefined}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-on-surface-variant hover:bg-surface-hover hover:text-on-surface"
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
