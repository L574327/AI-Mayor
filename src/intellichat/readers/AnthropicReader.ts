import Debug from 'debug';
import { IChatResponseMessage } from 'intellichat/types';
import BaseReader from './BaseReader';
import { ITool } from './IChatReader';

const debug = Debug('app:intellichat:AnthropicReader');

/**
 * Reader implementation for processing Anthropic API streaming responses.
 * Handles parsing of JSON chunks and converts them to standardized chat response messages.
 */
export default class AnthropicReader extends BaseReader {
  /**
   * Processes a single chunk from the Anthropic streaming response.
   * @param {string} chunk - Raw string chunk from the stream
   * @returns {IChatResponseMessage | null} Parsed message object or null if parsing fails
   */
  protected processChunk(chunk: string): IChatResponseMessage | null {
    try {
      // Each chunk is a complete JSON message in Anthropic's format
      return this.parseReply(chunk);
    } catch (error) {
      debug('Failed to process chunk:', error);
      return null;
    }
  }

  /**
   * Parses a JSON chunk from Anthropic's streaming format into a standardized response message.
   * Handles various message types including content blocks, deltas, message lifecycle events, and errors.
   * @param {string} chunk - JSON string containing the message data
   * @returns {IChatResponseMessage} Standardized chat response message object
   */
  protected parseReply(chunk: string): IChatResponseMessage {
    const data = JSON.parse(chunk);
    if (data.type === 'content_block_start') {
      if (data.content_block.type === 'tool_use') {
        return {
          toolCalls: [
            {
              id: data.content_block.id,
              name: data.content_block.name,
              args: '',
            },
          ],
          isEnd: false,
        };
      }
      return {
        content: data.content_block.text,
        isEnd: false,
      };
    }
    if (data.type === 'content_block_delta') {
      if (data.delta.type === 'input_json_delta') {
        return {
          content: '',
          toolCalls: [
            {
              args: data.delta.partial_json,
              index: 0,
            },
          ],
        };
      }
      return {
        content: data.delta.text,
        isEnd: false,
      };
    }
    if (data.type === 'message_start') {
      return {
        content: '',
        isEnd: false,
        inputTokens: data.message.usage.input_tokens,
        outputTokens: data.message.usage.output_tokens,
      };
    }
    if (data.type === 'message_delta') {
      return {
        content: '',
        isEnd: false,
        outputTokens: data.usage.output_tokens,
      };
    }
    if (data.type === 'message_stop') {
      return {
        content: '',
        isEnd: true,
      };
    }
    if (data.type === 'error') {
      return {
        content: '',
        error: {
          type: data.delta.type,
          message: data.delta.text,
        },
      };
    }
    if (data.type === 'ping') {
      return {
        content: '',
        isEnd: false,
      };
    }
    console.warn('Unknown message type', data);
    return {
      content: '',
      isEnd: false,
    };
  }

  /**
   * Extracts tool information from a chat response message.
   * @param {IChatResponseMessage} respMsg - The response message to parse
   * @returns {ITool | null} Tool object with id and name, or null if no tools found
   */
  protected parseTools(respMsg: IChatResponseMessage): ITool | null {
    if (respMsg.toolCalls && respMsg.toolCalls.length > 0) {
      return {
        id: respMsg.toolCalls[0].id,
        name: respMsg.toolCalls[0].name,
      };
    }
    return null;
  }

  /**
   * Extracts tool arguments from a chat response message.
   * @param {IChatResponseMessage} respMsg - The response message containing tool call data
   * @returns {{index: number; args: string;} | null} Object with tool index and arguments, or null if not available
   */
  protected parseToolArgs(respMsg: IChatResponseMessage): {
    index: number;
    args: string;
  } | null {
    debug('parseToolArgs', JSON.stringify(respMsg));
    try {
      if (respMsg.isEnd || !respMsg.toolCalls) {
        return null;
      }
      return respMsg.toolCalls[0];
    } catch (err) {
      console.error('parseToolArgs', err);
    }
    return null;
  }
}