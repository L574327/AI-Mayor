import Debug from 'debug';
import { IChatResponseMessage } from 'intellichat/types';
import BaseReader from './BaseReader';
import IChatReader, { ITool } from './IChatReader';

const debug = Debug('app:intellichat:OpenAIReader');

/**
 * OpenAIReader handles parsing of streaming responses from OpenAI's chat API.
 * It processes OpenAI's specific JSON format with choices and delta objects.
 */
export default class OpenAIReader extends BaseReader implements IChatReader {
  /**
   * Parse an OpenAI response chunk into a structured message.
   * Extracts content, reasoning, and tool calls from the choices[0].delta object.
   * @throws {Error} If the response contains an error field
   */
  protected parseReply(chunk: string): IChatResponseMessage {
    const data = JSON.parse(chunk);
    if (data.error) {
      throw new Error(data.error.message || data.error);
    }
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          promptCacheHitTokens: data.usage.prompt_cache_hit_tokens ?? 0,
          promptCacheMissTokens: data.usage.prompt_cache_miss_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined;
    const metadata = {
      requestId: data.id,
      responseModel: data.model,
      usage,
      inputTokens: usage?.promptTokens,
      outputTokens: usage?.completionTokens,
    };
    if (data.choices.length === 0) {
      return {
        content: '',
        reasoning: '',
        isEnd: false,
        toolCalls: [],
        ...metadata,
      };
    }
    const choice = data.choices[0];
    return {
      content: choice.delta.content || '',
      reasoning: choice.delta.reasoning_content || '',
      isEnd: false,
      toolCalls: choice.delta.tool_calls,
      ...metadata,
    };
  }

  /**
   * Extract tool information from the first tool call in the response.
   * Returns the tool's id and function name, or null if no tool calls exist.
   */
  protected parseTools(respMsg: IChatResponseMessage): ITool | null {
    if (respMsg.toolCalls && respMsg.toolCalls.length > 0) {
      return {
        id: respMsg.toolCalls[0].id,
        name: respMsg.toolCalls[0].function.name,
      };
    }
    return null;
  }

  /**
   * Extract tool arguments from the first tool call in the response.
   * Returns the argument index and the arguments string, or null if the message
   * has ended or contains no tool calls.
   */
  protected parseToolArgs(respMsg: IChatResponseMessage): {
    index: number;
    args: string;
  } | null {
    try {
      if (respMsg.isEnd || !respMsg.toolCalls) {
        return null;
      }
      const toolCalls = respMsg.toolCalls[0];
      return {
        index: toolCalls.index || 0,
        args: toolCalls.function?.arguments || '',
      };
    } catch (err) {
      console.error('parseToolArgs', err);
    }
    return null;
  }
}
