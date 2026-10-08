import { create } from 'zustand';
import Debug from 'debug';
import { ICollection } from 'types/knowledge';
import { isUndefined, union } from 'lodash';
import { TEMP_CHAT_ID } from 'consts';
import { typeid } from 'typeid-js';

const debug = Debug('app:stores:useChatKnowledgeStore');

export interface IChatKnowledgeStore {
  changes: { [key: string]: boolean };
  chatCollections: { [key: string]: ICollection[] };
  listChatCollections: (chatId: string) => Promise<ICollection[]>;
  moveChatCollections: (
    fromChatId: string,
    targetChatId: string,
  ) => ICollection[];
  setChatCollections: (
    chatId: string,
    collections: ICollection[],
  ) => Promise<boolean>;
  removeChatCollection: (
    chatId: string,
    collectionId: string,
  ) => Promise<boolean>;
}

const useKnowledgeStore = create<IChatKnowledgeStore>((set, get) => ({
  changes: {},
  chatCollections: {},
  moveChatCollections: (fromChatId: string, targetChatId: string) => {
    set((state) => {
      const fromCollections = state.chatCollections[fromChatId] || [];
      const targetCollections = state.chatCollections[targetChatId] || [];
      state.chatCollections[targetChatId] = union(
        targetCollections,
        fromCollections,
      );
      state.chatCollections[fromChatId] = [];
      debug(
        `move collections from ${fromChatId} to ${targetChatId}`,
        state.chatCollections[targetChatId],
      );
      return state;
    });
    return get().chatCollections[targetChatId];
  },
  listChatCollections: async (chatId) => {
    let collections: ICollection[] = [];
    const changed = get().changes[chatId];
    if (isUndefined(changed) || changed) {
      collections = (await window.electron.db.all(
        `SELECT kc.id, kc.name, kc.updatedAt, kc.createdAt, count(kf.id) numOfFiles FROM chat_knowledge_rels rel
LEFT JOIN knowledge_collections kc on rel.collectionId = kc.id
LEFT JOIN knowledge_files kf on kc.id = kf.collectionId
WHERE rel.chatId = ?
GROUP BY kc.id, kc.name, kc.updatedAt, kc.createdAt
ORDER BY kc.updatedAt DESC`,
        [chatId],
      )) as ICollection[];
      set((state) => {
        state.chatCollections[chatId] = collections;
        state.changes[chatId] = false;
        return state;
      });
    }
    return get().chatCollections[chatId];
  },
  setChatCollections: async (chatId, collections) => {
    let ok = true;
    // 只有数据库中的 Chat 才更新 chat_knowledge_rels 表
    if (chatId !== TEMP_CHAT_ID) {
      if (collections.length === 0) {
        ok = await window.electron.db.run(
          `DELETE FROM chat_knowledge_rels WHERE chatId = ?`,
          [chatId],
        );
        ok = true;
      } else {
        ok = await window.electron.db.transaction([
          {
            sql: `DELETE FROM chat_knowledge_rels WHERE chatId = ?`,
            params: [chatId],
          },
          {
            sql: `INSERT INTO chat_knowledge_rels (id, chatId, collectionId) VALUES (?, ?, ?)`,
            params: collections.map((collection) => [
              typeid('ckr').toString(),
              chatId,
              collection.id,
            ]),
          },
        ]);
      }
    }
    if (ok) {
      set((state) => ({
        chatCollections: {
          ...state.chatCollections,
          [chatId]: collections,
        },
      }));
    }
    return ok;
  },
  removeChatCollection: async (chatId, collectionId) => {
    let ok = true;
    // 只有数据库中的 Chat 才更新 chat_knowledge_rels 表
    if (chatId !== TEMP_CHAT_ID) {
      ok = await window.electron.db.run(
        `DELETE FROM chat_knowledge_rels WHERE chatId = ? AND collectionId = ?`,
        [chatId, collectionId],
      );
    }
    if (ok) {
      set((state) => {
        state.chatCollections[chatId] = state.chatCollections[chatId].filter(
          (collection) => collection.id !== collectionId,
        );
        return state;
      });
    }
    return ok;
  },
}));

export default useKnowledgeStore;
