import { IChatContext } from 'intellichat/types';
import OpenAIChatService from './OpenAIChatService';
import Grok from '../../providers/Grok';
import INextChatService from './INextCharService';

export default class GrokChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = Grok;
  }
}
