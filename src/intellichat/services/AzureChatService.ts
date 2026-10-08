import { IChatContext, IChatRequestMessage } from 'intellichat/types';
import { urlJoin } from 'utils/util';
import OpenAIChatService from './OpenAIChatService';
import Azure from '../../providers/Azure';
import INextChatService from './INextCharService';

/**
 * Azure-specific implementation of the chat service that extends OpenAI chat functionality
 * for Azure OpenAI deployments. Handles Azure-specific URL construction and authentication.
 */
export default class AzureChatService
  extends OpenAIChatService
  implements INextChatService
{
  /**
   * Creates a new AzureChatService instance.
   * @param {string} name - The name identifier for this chat service instance
   * @param {IChatContext} chatContext - The chat context containing configuration and state
   */
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = Azure;
  }

  /**
   * Makes an HTTP request to the Azure OpenAI chat completions endpoint.
   * Constructs the Azure-specific URL using deployment ID and API version,
   * and sets up proper authentication headers.
   * @param {IChatRequestMessage[]} messages - Array of chat messages to send
   * @param {string} [msgId] - Optional message identifier
   * @returns {Promise<Response>} Promise that resolves to the HTTP response
   * @protected
   */
  protected async makeRequest(
    messages: IChatRequestMessage[],
    msgId?: string,
  ): Promise<Response> {
    const provider = this.context.getProvider();
    const model = this.context.getModel();
    const deploymentId = model.extras?.deploymentId || model.name;
    const url = urlJoin(
      `/openai/deployments/${deploymentId}/chat/completions?api-version=${provider.apiVersion}`,
      provider.apiBase.trim(),
    );
    const headers = {
      'Content-Type': 'application/json',
      'api-key': provider.apiKey.trim(),
    };
    const isStream = this.context.isStream();
    const payload = await this.makePayload(messages, msgId);
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}
