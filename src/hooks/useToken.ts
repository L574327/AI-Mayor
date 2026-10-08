import {
  isGPT,
  isGemini,
  isMoonshot,
  isDoubao,
  isGrok,
  isDeepSeek,
  isPerplexity,
} from 'utils/util';
import {
  countGPTTokens,
  countTokensOfGemini,
  countTokensOfMoonshot,
  countTokenOfLlama,
} from 'utils/token';
import { IChatMessage, IChatRequestMessage } from 'intellichat/types';
import ChatContext from 'renderer/ChatContext';

const IMAGE_TOKEN_DENSITY = 20;
const AUDIO_TOKEN_DENSITY = 3;

export default function useToken() {
  return {
    countInput: async (prompt: string): Promise<number> => {
      const modelName = ChatContext.getModel().name;
      if (
        isGPT(modelName) ||
        isDoubao(modelName) ||
        isGrok(modelName) ||
        isDeepSeek(modelName) ||
        isPerplexity(modelName)
      ) {
        const messages: IChatRequestMessage[] = [];
        ChatContext.getCtxMessages().forEach((msg: IChatMessage) => {
          messages.push({ role: 'user', content: msg.prompt });
          messages.push({ role: 'assistant', content: msg.reply });
        });
        messages.push({ role: 'user', content: prompt });
        return Promise.resolve(countGPTTokens(messages, modelName));
      }

      if (isGemini(modelName)) {
        const provider = ChatContext.getProvider();
        const messages: IChatRequestMessage[] = [];
        ChatContext.getCtxMessages().forEach((msg: IChatMessage) => {
          messages.push({ role: 'user', parts: [{ text: msg.prompt }] });
          messages.push({ role: 'model', parts: [{ text: msg.reply }] });
        });
        messages.push({ role: 'user', parts: [{ text: prompt }] });
        return countTokensOfGemini(
          messages,
          provider.apiBase,
          provider.apiKey as string,
          modelName,
        );
      }

      if (isMoonshot(modelName)) {
        const provider = ChatContext.getProvider();
        const messages: IChatRequestMessage[] = [];
        ChatContext.getCtxMessages().forEach((msg: IChatMessage) => {
          messages.push({ role: 'user', content: msg.prompt });
          messages.push({ role: 'assistant', content: msg.reply });
        });
        messages.push({ role: 'user', content: prompt });
        return countTokensOfMoonshot(
          messages,
          provider.apiBase,
          provider.apiKey as string,
          modelName,
        );
      }

      // Note: use Llama as default
      const messages: IChatRequestMessage[] = [];
      ChatContext.getCtxMessages().forEach((msg: IChatMessage) => {
        messages.push({ role: 'user', content: msg.prompt });
        messages.push({ role: 'assistant', content: msg.reply });
      });
      messages.push({ role: 'user', content: prompt });
      return Promise.resolve(countTokenOfLlama(messages, modelName));
    },
    countOutput: async (reply: string): Promise<number> => {
      const modelName = ChatContext.getModel().name;
      if (
        isGPT(modelName) ||
        isDoubao(modelName) ||
        isGrok(modelName) ||
        isDeepSeek(modelName)
      ) {
        return Promise.resolve(
          countGPTTokens([{ role: 'assistant', content: reply }], modelName),
        );
      }
      if (isGemini(modelName)) {
        const provider = ChatContext.getProvider();
        const messages: IChatRequestMessage[] = [
          { role: 'model', parts: [{ text: reply }] },
        ];
        return countTokensOfGemini(
          messages,
          provider.apiBase,
          provider.apiKey as string,
          modelName,
        );
      }
      if (isMoonshot(modelName)) {
        const provider = ChatContext.getProvider();
        return countTokensOfMoonshot(
          [{ role: 'assistant', content: reply }],
          provider.apiBase,
          provider.apiKey as string,
          modelName,
        );
      }
      // Note: use Llama as default
      return Promise.resolve(
        countTokenOfLlama([{ role: 'assistant', content: reply }], modelName),
      );
    },
    countBlobInput: (base64: string, type: 'image' | 'audio') => {
      const size = atob(base64).length / 1024; // kb

      if (type === 'image') {
        return Math.ceil(size * IMAGE_TOKEN_DENSITY);
      }

      return Math.ceil(size * AUDIO_TOKEN_DENSITY);
    },
  };
}
