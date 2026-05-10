import { FormEvent, useState } from 'react';
import { Loader2, Plus, Send } from 'lucide-react';

export function ChatInput({
  disabled,
  disabledPlaceholder = 'Confirm or cancel the proposal first',
  isThinking,
  onSubmit,
}: {
  disabled: boolean;
  disabledPlaceholder?: string;
  isThinking: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-3 rounded-3xl border border-outline bg-surface p-3 shadow-sm">
      <button type="button" className="mb-1 rounded-full p-2 text-on-surface-variant hover:bg-surface-hover" aria-label="Add attachment">
        <Plus className="h-5 w-5" />
      </button>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={1}
        disabled={disabled}
        placeholder={disabled ? disabledPlaceholder : 'Ask your wallet copilot…'}
        className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant disabled:cursor-not-allowed"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) submit(event);
        }}
      />
      <button disabled={!value.trim() || disabled} className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40" aria-label="Send message">
        {isThinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </button>
    </form>
  );
}
