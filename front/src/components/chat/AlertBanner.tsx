import { AlertTriangle, Info } from 'lucide-react';
import type { AgentChatMessage } from '@/types/chat';

export function AlertBanner({ message }: { message: Extract<AgentChatMessage, { type: 'alert' }> }) {
  const danger = message.severity === 'danger';
  const warning = message.severity === 'warning';
  return (
    <div className={`rounded-2xl border p-4 ${danger ? 'border-error-border bg-error-bg text-error-text' : warning ? 'border-warning-border bg-warning-bg text-warning-text' : 'border-outline bg-surface text-on-surface'}`}>
      <div className="flex items-start gap-3">
        {warning || danger ? <AlertTriangle className="mt-0.5 h-5 w-5" /> : <Info className="mt-0.5 h-5 w-5" />}
        <p className="text-sm font-medium">{message.content}</p>
      </div>
    </div>
  );
}
