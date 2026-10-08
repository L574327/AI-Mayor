import Debug from 'debug';
import { IChatResponseMessage } from 'intellichat/types';
import IChatReader from './IChatReader';
import OpenAIReader from './OpenAIReader';

const debug = Debug('app:intellichat:OllamaReader');

export default class OllamaReader extends OpenAIReader implements IChatReader {
  protected parseReply(chunk: string): IChatResponseMessage {
    const data = JSON.parse(chunk);
    if (data.done) {
      return {
        content: data.message.content,
        isEnd: true,
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      };
    }
    return {
      content: data.message.content,
      isEnd: false,
      toolCalls: data.message.tool_calls,
    };
  }
}
