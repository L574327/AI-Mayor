export interface ICollection {
  id: string;
  name: string;
  memo?: string;
  numOfFiles?: number;
  favorite?: boolean;
  pinedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ICollectionFile {
  id: string;
  collectionId: string;
  name: string;
  size: number;
  numOfChunks?: number;
  createdAt: number;
  updatedAt: number;
}

export interface IKnowledgeChunk {
  id: string;
  collectionId: string;
  fileId: string;
  content: string;
}
