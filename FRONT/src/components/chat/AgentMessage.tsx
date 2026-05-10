import { Bot } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { AgentChatMessage } from '@/types/chat';

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>;
    }

    return <Fragment key={index}>{part}</Fragment>;
  });
}

function renderMessageContent(content: string) {
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="my-2 list-disc space-y-1 pl-5">
        {listItems.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((line, index) => {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();
    if (!line.trim()) {
      blocks.push(<div key={`space-${index}`} className="h-2" />);
      return;
    }

    blocks.push(
      <p key={`line-${index}`} className="my-1 first:mt-0 last:mb-0">
        {renderInlineMarkdown(line)}
      </p>
    );
  });

  flushList();
  return blocks;
}

export function AgentMessage({ message }: { message: Extract<AgentChatMessage, { type: 'text' }> }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-agent-bubble text-primary">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[78%] rounded-3xl rounded-bl-md bg-agent-bubble px-5 py-3 text-[15px] leading-relaxed text-on-agent-bubble">
        {renderMessageContent(message.content)}
      </div>
    </div>
  );
}
