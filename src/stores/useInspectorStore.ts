import { typeid } from 'typeid-js';
import { create } from 'zustand';

export interface ITraceMessage {
  id: string;
  label: string;
  message: string;
}

interface IInspectorStore {
  messages: { [key: string]: ITraceMessage[] };
  trace: (chatId: string, label: string, message: string) => void;
  clearTrace: (chatId: string) => void;
}

const useInspectorStore = create<IInspectorStore>((set, get) => ({
  messages: {},
  trace: (chatId: string, label: string, message: string) => {
    const { messages } = get();
    const id = typeid('trace').toString();
    if (!messages[chatId]) {
      set({ messages: { ...messages, [chatId]: [{ id, label, message }] } });
    } else {
      set({
        messages: {
          ...messages,
          [chatId]: messages[chatId].concat([{ id, label, message }]),
        },
      });
    }
  },
  clearTrace: (chatId: string) => {
    const { messages } = get();
    delete messages[chatId];
    set({ messages: { ...messages } });
  },
}));

export default useInspectorStore;
