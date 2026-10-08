import Debug from 'debug';
import {
  IChatContext,
  IChatRequestMessage,
} from 'intellichat/types';

import Fire from 'providers/Fire';
import useAuthStore from 'stores/useAuthStore';
import { urlJoin } from 'utils/util';
import INextChatService from './INextCharService';
import OpenAIChatService from './OpenAIChatService';

const debug = Debug('app:intellichat:FireChatService');

/**
 * Chat service implementation that extends OpenAIChatService to work with the Fire provider.
 * Handles authentication using user sessions and makes requests to Fire's chat completion API.
 */
export default class FireChatService
  extends OpenAIChatService
  implements INextChatService
{
  /**
   * Creates a new FireChatService instance.
   * @param {string} name - The name identifier for this chat service
   * @param {IChatContext} context - The chat context containing configuration and provider details
   */
  constructor(name:string, context: IChatContext) {
    super(name, context);
    this.provider = Fire;
  }

  /**
   * Retrieves the current user's ID from the authentication store.
   * @private
   * @returns {string | undefined} The user ID if authenticated, undefined otherwise
   */
  private getUserId() {
    const { session } = useAuthStore.getState();
    return session?.user.id;
  }

  /**
   * Makes an HTTP request to the Fire chat completions API with user authentication.
   * @protected
   * @param {IChatRequestMessage[]} messages - Array of chat messages to send
   * @param {string} [msgId] - Optional message ID for tracking
   * @returns {Promise<Response>} Promise that resolves to the HTTP response
   * @throws {Error} Throws an error if the user is not authenticated
   */
  protected async makeRequest(
    messages: IChatRequestMessage[],
    msgId?: string
  ): Promise<Response> {
    const payload = await this.makePayload(messages, msgId);
    debug('About to make a request, payload:\r\n', payload);
    const provider = this.context.getProvider();
    const key = this.getUserId();
    if (!key) {
      throw new Error('User is not authenticated');
    }
    const url = urlJoin(`/v1/chat/completions`, provider.apiBase.trim());
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    };
    const isStream = this.context.isStream();
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}