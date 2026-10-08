import { useEffect, useMemo, useState } from 'react';
import useNav from 'hooks/useNav';
import useChatStore from 'stores/useChatStore';
import { IChat } from 'intellichat/types';
import Mousetrap from 'mousetrap';
import { findIndex } from 'lodash';
import { DndContext } from '@dnd-kit/core';
import ChatFolders from 'renderer/components/ChatFolders';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import ChatItem from 'renderer/components/ChatItem';
import { Skeleton, SkeletonItem } from '@fluentui/react-components';

export default function ChatNav({ collapsed }: { collapsed: boolean }) {
  const [loading, setLoading] = useState(true);
  const chats = useChatStore((state) => state.chats);
  const curChat = useChatStore((state) => state.chat);
  const { updateChat, fetchFolder, selectFolder, fetchChats, openFolder } =
    useChatStore();
  const navigate = useNav();

  const chatsWithFolder = useMemo(
    () => chats.filter((chat: IChat) => chat.folderId),
    [chats],
  );
  const chatsWithoutFolder = useMemo(
    () => chats.filter((chat: IChat) => !chat.folderId),
    [chats],
  );

  const loadData = async () => {
    setLoading(true);
    await Promise.all([fetchFolder(), fetchChats()]);
    setLoading(false);
  };

  useEffect(() => {
    Mousetrap.bind('mod+shift+up', () => {
      let index = 0;
      if (chatsWithoutFolder.length) {
        if (curChat) {
          const curIdx = findIndex(
            chatsWithoutFolder,
            (item: IChat) => item.id === curChat.id,
          );
          index = Math.max(curIdx - 1, 0);
        }
        navigate(`/chats/${chatsWithoutFolder[index].id}`);
      }
    });
    Mousetrap.bind('mod+shift+down', () => {
      let index = 0;
      if (chatsWithoutFolder.length) {
        if (curChat) {
          const curIdx = findIndex(
            chatsWithoutFolder,
            (item: IChat) => item.id === curChat.id,
          );
          index = Math.min(curIdx + 1, chats.length - 1);
        }
        navigate(`/chats/${chatsWithoutFolder[index].id}`);
      }
    });
    return () => {
      Mousetrap.unbind('mod+up');
      Mousetrap.unbind('mod+down');
    };
  }, [chats.length, curChat?.id]);

  useEffect(() => {
    loadData();
  }, []);

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    navigate(`/chats/${active.id}`);
    setTimeout(() => {
      selectFolder(active.data.current.folderId || null);
      if (active.data.current.folderId !== (over?.id || null)) {
        updateChat({ id: active.id, folderId: over?.id || null });
        selectFolder(over?.id || null);
        if (over?.id) {
          openFolder(over?.id);
        }
      }
    }, 0);
  };
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden chat-nav scrollbar-hide">
      {loading ? (
        <Skeleton
          aria-label="Loading chats"
          appearance="translucent"
          className="flex flex-col pt-3 gap-2 mx-3"
        >
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '100%'}` }}
          />
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '200px'}` }}
          />
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '120px'}` }}
          />
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '220px'}` }}
          />
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '200px'}` }}
          />
          <SkeletonItem
            size={20}
            style={{ width: `${collapsed ? '60px' : '200px'}` }}
          />
        </Skeleton>
      ) : (
        <DndContext
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <div
            className={`flex flex-col pt-2 ${collapsed ? 'content-center' : ''}`}
          >
            <div className={`mb-1 ${collapsed ? 'mx-auto' : ''}`}>
              <ChatFolders chats={chatsWithFolder} collapsed={collapsed} />
            </div>
            {chatsWithoutFolder.map((chat: IChat) => {
              return (
                <div
                  className={collapsed ? ' mx-auto' : 'px-0.5'}
                  key={chat.id}
                >
                  <ChatItem key={chat.id} chat={chat} collapsed={collapsed} />
                </div>
              );
            })}
          </div>
        </DndContext>
      )}
    </div>
  );
}
