export interface IBookmark {
  id: string;
  msgId: string;
  prompt: string;
  reply: string;
  reasoning?: string;
  model: string;
  temperature: number;
  memo?: string;
  favorite?: boolean;
  citedFiles?: string;
  citedChunks?: string;
  createdAt: number;
}
