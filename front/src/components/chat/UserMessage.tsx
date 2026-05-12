import type { UserChatMessage } from '@/types/chat';

export function UserMessage({ message }: { message: UserChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-3xl rounded-br-md bg-primary px-5 py-3 text-[15px] leading-relaxed text-on-primary shadow-sm">
        {message.content}
      </div>
    </div>
  );
}
