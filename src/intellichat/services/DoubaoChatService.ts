import { IChatContext, IChatRequestMessage } from 'intellichat/types';
import { urlJoin } from 'utils/util';
import OpenAIChatService from './OpenAIChatService';
import Doubao from '../../providers/Doubao';
import INextChatService from './INextCharService';

export default class DoubaoChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = Doubao;
  }

  protected async makeRequest(
    messages: IChatRequestMessage[],
    msgId?: string,
  ): Promise<Response> {
    const provider = this.context.getProvider();
    const model = this.context.getModel();
    const modelId = model.extras?.modelId || model.name;
    const payload = await this.makePayload(messages, msgId);
    payload.model = modelId;
    payload.stream = true;
    const url = urlJoin('/chat/completions', provider.apiBase.trim());
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey.trim()}`,
    };
    const isStream = this.context.isStream();
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}
