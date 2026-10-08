// import Debug from 'debug';
import { IChatContext } from 'intellichat/types';
import Moonshot from 'providers/Moonshot';
import OpenAIChatService from './OpenAIChatService';
import INextChatService from './INextCharService';

// const debug = Debug('app:intellichat:MoonshotChatService');

export default class MoonshotChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, context: IChatContext) {
    super(name, context);
    this.provider = Moonshot;
  }
}
