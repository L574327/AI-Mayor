import Debug from 'debug';
import { urlJoin } from 'utils/util';
import Baidu from '../../providers/Baidu';
import { IChatContext, IChatRequestMessage } from '../types';
import INextChatService from './INextCharService';
import OpenAIChatService from './OpenAIChatService';

const debug = Debug('app:intellichat:BaiduChatService');

/**
 * Chat service implementation for Baidu API that extends OpenAI chat service functionality.
 * Handles chat requests by formatting them according to Baidu's API requirements.
 */
export default class BaiduChatService
  extends OpenAIChatService
  implements INextChatService
{
  /**
   * Creates a new BaiduChatService instance.
   * @param {string} name - The name identifier for this chat service
   * @param {IChatContext} context - The chat context containing configuration and state
   */
  constructor(name: string, context: IChatContext) {
    super(name, context);
    this.provider = Baidu;
  }

  /**
   * Makes an HTTP request to Baidu's chat API with the provided messages.
   * Formats the request payload according to Baidu's API specifications and handles authentication.
   * @param {IChatRequestMessage[]} messages - Array of chat messages to send
   * @param {string} [msgId] - Optional message identifier
   * @returns {Promise<Response>} Promise that resolves to the HTTP response from Baidu's API
   * @protected
   */
  protected async makeRequest(
    messages: IChatRequestMessage[],
    msgId?: string,
  ): Promise<Response> {
    const payload = await this.makePayload(messages, msgId);
    debug('About to make a request, payload:\r\n', payload);
    const provider = this.context.getProvider();

    const apiKey = provider.apiKey.trim();
    payload.model = (this.getModelName() as string).toLowerCase();

    const url = urlJoin('/v2/chat/completions', provider.apiBase.trim());
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    const isStream = this.context.isStream();
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}