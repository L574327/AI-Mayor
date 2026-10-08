import { IChatContext, IChatRequestMessage } from 'intellichat/types';
import { ITool } from 'intellichat/readers/IChatReader';
import OpenAIChatService from './OpenAIChatService';
import Mistral from '../../providers/Mistral';
import INextChatService from './INextCharService';

export default class MistralChatService
  extends OpenAIChatService
  implements INextChatService
{
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = Mistral;
  }

  /**
   * Override makeToolMessages to handle MCP placeholder scenarios.
   *
   * In some cases (e.g., MCP tools), the tool output cannot be converted
   * into an OpenAI-compatible tool message, so a placeholder user message
   * is inserted instead.
   *
   * However, in Mistral, every tool message must be immediately followed
   * by an assistant message. Therefore, when the message sequence is:
   *
   *   [assistant, tool, user (placeholder)]
   *
   * a minimal assistant "bridge" message is inserted before the placeholder
   * user message. This satisfies the protocol requirements and instructs
   * the model to ignore the placeholder output while continuing to process
   * the subsequent user message.
   */
  protected override async makeToolMessages(
    tool: ITool,
    toolResult: any,
  ): Promise<IChatRequestMessage[]> {
    const messages = await super.makeToolMessages(tool, toolResult);

    if (messages.length === 3 && messages[2].role === 'user') {
      messages.splice(2, 0, {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Got it. Please ignore the placeholder tool output above and continue with the next user message.',
          },
        ],
      });
    }

    return messages;
  }
}
