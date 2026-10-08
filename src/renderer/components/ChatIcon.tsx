import { Tooltip } from '@fluentui/react-components';
import { Chat20Filled, Chat20Regular } from '@fluentui/react-icons';
import { IChat } from 'intellichat/types';
import useChatStore from 'stores/useChatStore';
import Spinner from './Spinner';

export default function ChatIcon({
  chat,
  isActive,
}: {
  chat: IChat;
  isActive: boolean;
}) {
  const chatStates = useChatStore((state) => state.states);

  const renderChatIcon = () => {
    if (chatStates[chat.id]?.loading) {
      return <Spinner size={18} />;
    }
    if (isActive) {
      return <Chat20Filled />;
    }
    return <Chat20Regular />;
  };

  return (
    <Tooltip
      withArrow
      content={chat.name || chat.summary?.substring(0, 200)}
      relationship="label"
      positioning="above-start"
    >
      {renderChatIcon()}
    </Tooltip>
  );
}
