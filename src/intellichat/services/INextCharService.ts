import { IChatContext, IChatRequestMessage } from 'intellichat/types';
import { IServiceProvider } from 'providers/types';

export default interface INextChatService {
  name: string;
  context: IChatContext;
  provider: IServiceProvider;
  chat(message: IChatRequestMessage[], msgId?: string): void;
  abort(): void;
  onComplete(callback: (result: any) => Promise<void>): void;
  onToolCalls(callback: (toolName: string) => void): void;
  onReading(callback: (chunk: string, reasoning?: string) => void): void;
  onError(callback: (error: any, aborted: boolean) => void): void;
}
