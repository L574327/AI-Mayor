import { IChatContext, IChatResponseMessage } from 'intellichat/types';
import { IServiceProvider } from 'providers/types';

export default interface IChatService {
  context: IChatContext;
  provider: IServiceProvider;
  apiSettings: {
    base: string;
    key: string;
    model: string;
    secret?: string; // baidu
    deploymentId?: string; // azure
  };

  chat({
    message,
    onMessage,
    onComplete,
    onError,
  }: {
    message: string;
    onMessage: (message: string) => void;
    onComplete: (result: IChatResponseMessage) => void;
    onError: (error: any, aborted: boolean) => void;
  }): void;
  abort(): void;
  isReady(): boolean;
}
