import { IChatContext } from 'intellichat/types';
import OpenAIChatService from './OpenAIChatService';
import LMStudio from '../../providers/LMStudio';
import INextChatService from './INextCharService';

export default class LMStudioChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = LMStudio;
  }
}
