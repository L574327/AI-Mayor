import { IChatContext, IChatRequestMessage } from 'intellichat/types';
import { urlJoin } from 'utils/util';
import OpenAIChatService from './OpenAIChatService';
import Zhipu from '../../providers/Zhipu';
import INextChatService from './INextCharService';

export default class ZhipuChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = Zhipu;
  }

  protected async makeRequest(
    messages: IChatRequestMessage[],
    msgId?: string,
  ): Promise<Response> {
    const provider = this.context.getProvider();
    const url = urlJoin('/chat/completions', provider.apiBase.trim());
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey.trim()}`,
    };
    const isStream = this.context.isStream();
    const payload = await this.makePayload(messages, msgId);
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}
