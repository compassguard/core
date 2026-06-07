import { Compass, History, MessageCircle, WalletCards } from 'lucide-react';

const items = [
  { label: 'Chat', icon: MessageCircle },
  { label: 'Assets', icon: WalletCards },
  { label: 'Explore', icon: Compass },
  { label: 'History', icon: History },
];

export function BottomNav({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-outline bg-surface/95 px-2 py-2 backdrop-blur md:hidden">
      <div className="grid grid-cols-4 gap-1">
        {items.map(({ label, icon: Icon }) => (
          <button key={label} onClick={() => onTabChange(label)} className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs font-semibold ${activeTab === label ? 'bg-primary/10 text-primary' : 'text-on-surface-variant'}`}>
            <Icon className="h-5 w-5" />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
