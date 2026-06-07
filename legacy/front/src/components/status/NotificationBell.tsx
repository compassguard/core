import { Bell } from 'lucide-react';

export function NotificationBell({ hasUnread = true }: { hasUnread?: boolean }) {
  return (
    <button className="relative rounded-full border border-outline bg-surface p-2 text-on-surface-variant shadow-sm hover:bg-surface-hover hover:text-on-surface" aria-label="Notifications">
      <Bell className="h-5 w-5" />
      {hasUnread ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-error-text" /> : null}
    </button>
  );
}
