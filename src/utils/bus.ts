import mitt from 'mitt';

export type RetryEvent = {
  prompt: string;
  messageId: string;
};

const eventBus = mitt();

export default eventBus;
