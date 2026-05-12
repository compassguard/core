import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import type { AgentChatMessage } from '@/types/chat';
import { explorerTxUrl } from '@/lib/format';

export function TxResultMessage({ message }: { message: Extract<AgentChatMessage, { type: 'text' }> }) {
  const execute = message.execute;
  const success = execute?.status === 'success';

  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${success ? 'border-success/20 bg-success-bg' : 'border-error-border bg-error-bg'}`}>
      <div className="flex items-start gap-3">
        {success ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" /> : <XCircle className="mt-0.5 h-5 w-5 text-error-text" />}
        <div>
          <p className="text-sm font-semibold text-on-surface">{message.content}</p>
          {execute?.tx_hash ? (
            <a href={explorerTxUrl(execute.tx_hash)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              View transaction <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {execute?.error ? <p className="mt-2 text-xs text-error-text">{execute.error}</p> : null}
        </div>
      </div>
    </div>
  );
}
