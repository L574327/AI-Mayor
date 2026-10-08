import { create } from 'zustand';
import Debug from 'debug';
import { ICollection, ICollectionFile, IKnowledgeChunk } from 'types/knowledge';
import { typeid } from 'typeid-js';
import { date2unix } from 'utils/util';
import { isUndefined, omitBy } from 'lodash';

const debug = Debug('app:stores:useKnowledgeStore');

export interface IKnowledgeStore {
  collectionChangedAt: number | null;
  citation: { open: boolean; content: string };
  chunks: { [key: string]: IKnowledgeChunk }; // cache chunks
  showCitation: (content: string) => void;
  hideCitation: () => void;
  cacheChunks: (chunk: IKnowledgeChunk[]) => void;
  getChunk: (id: string) => Promise<IKnowledgeChunk | null>;
  createCollection: (collection: Partial<ICollection>) => Promise<ICollection>;
  updateCollection: (
    collection: { id: string } & Partial<ICollection>,
  ) => Promise<boolean>;
  deleteCollection: (id: string) => Promise<boolean>;
  listCollections: () => Promise<ICollection[]>;
  getCollection: (id: string) => Promise<ICollection | null>;
  createFile: (
    file: { collectionId: string; name: string } & Partial<ICollectionFile>,
  ) => Promise<ICollectionFile>;
  getFiles: (fileIds: string[]) => Promise<ICollectionFile[]>;
  deleteFile: (id: string) => Promise<boolean>;
  listFiles: (collectionId: string) => Promise<ICollectionFile[]>;
}

const useKnowledgeStore = create<IKnowledgeStore>((set, get) => ({
  collectionChangedAt: null,
  citation: { open: false, content: '' },
  chunks: {},
  showCitation: (content) => {
    set({ citation: { open: true, content } });
  },
  hideCitation: () => {
    set({ citation: { open: false, content: '' } });
  },
  cacheChunks: (chunks: IKnowledgeChunk[]) => {
    set((state) => {
      chunks.forEach((chunk) => {
        state.chunks[chunk.id] = chunk;
      });
      return state;
    });
  },
  getChunk: async (id) => {
    let chunk = get().chunks[id];
    if (!chunk) {
      chunk = await window.electron.knowledge.getChunk(id);
      if (chunk) {
        set((state) => {
          state.chunks[id] = chunk;
          return state;
        });
      }
    }
    return chunk;
  },
  createCollection: async (collection) => {
    const nowUnix = date2unix(new Date());
    const _collection = {
      ...collection,
      id: collection.id || typeid('kc').toString(),
      createdAt: nowUnix,
      updatedAt: nowUnix,
    } as ICollection;

    const ok = await window.electron.db.run(
      `INSERT INTO knowledge_collections (id, name, memo,  createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)`,
      [
        _collection.id,
        _collection.name,
        _collection.memo,
        _collection.createdAt,
        _collection.updatedAt,
      ],
    );
    if (!ok) {
      throw new Error(`Create collection "${_collection.name}" failed`);
    }
    set((state) => ({
      collectionChangedAt: nowUnix,
    }));
    debug('Create a knowledge collection ', _collection);
    return _collection as ICollection;
  },
  updateCollection: async (collection) => {
    const nowUnix = date2unix(new Date());
    const params = [];
    const columns = [];
    if (collection.name) {
      params.push(collection.name);
      columns.push('name = ?');
    }
    if (collection.memo) {
      params.push(collection.memo);
      columns.push('memo = ?');
    }
    if (!isUndefined(collection.pinedAt)) {
      params.push(collection.pinedAt);
      columns.push('pinedAt = ?');
    }
    params.push(nowUnix);
    columns.push('updatedAt = ?');
    params.push(collection.id);
    const sql = `UPDATE knowledge_collections SET ${columns.join(
      ', ',
    )} WHERE id = ?`;
    const ok = await window.electron.db.run(sql, params);
    if (!ok) {
      throw new Error(`Update collection "${collection.id}" failed`);
    }
    set((state) => ({
      collectionChangedAt: nowUnix,
    }));
    debug('updateCollection', params);
    return true;
  },
  deleteCollection: async (id) => {
    const ok = await window.electron.db.transaction([
      {
        sql: `DELETE FROM knowledge_collections WHERE id = ?`,
        params: [id],
      },
      {
        sql: `DELETE FROM knowledge_files WHERE collectionId = ?`,
        params: [id],
      },
      {
        sql: `DELETE FROM chat_knowledge_rels WHERE collectionId = ?`,
        params: [id],
      },
    ]);
    if (!ok) {
      throw new Error(`Delete knowledge collection(${id}) failed`);
    }
    await window.electron.knowledge.removeCollection(id);
    set((state) => ({
      collectionChangedAt: date2unix(new Date()),
      chunks: omitBy(
        state.chunks,
        (chunk: IKnowledgeChunk) => chunk.collectionId === id,
      ),
    }));
    console.log('deleteCollection, id:', id, ' at ', get().collectionChangedAt);
    return true;
  },
  listCollections: async () => {
    debug('Query collections from db');
    return (await window.electron.db.all(
      `
   SELECT c.id, c.name, c.memo, c.updatedAt, c.createdAt, c.pinedAt, count(f.id) AS numOfFiles FROM knowledge_collections c
LEFT JOIN knowledge_files f on f.collectionId = c.id
GROUP BY c.id, c.name, c.memo, c.updatedAt, c.createdAt, c.pinedAt
ORDER BY c.pinedAt DESC, c.updatedAt DESC`,
      [],
    )) as ICollection[];
  },
  getCollection: async (id) => {
    debug('getCollection', id);
    return (await window.electron.db.get(
      `SELECT id, name, memo FROM knowledge_collections WHERE id = ?`,
      id,
    )) as ICollection | null;
  },
  createFile: async (file) => {
    debug('createFile', file);
    const nowUnix = date2unix(new Date());
    const _file = {
      ...file,
      id: file.id || typeid('kf').toString(),
      createdAt: nowUnix,
      updatedAt: nowUnix,
    } as ICollectionFile;
    debug('Create a collection file ', _file);
    const ok = await window.electron.db.run(
      `INSERT INTO knowledge_files (id, collectionId, name, size, numOfChunks,  createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        _file.id,
        _file.collectionId,
        _file.name,
        _file.size,
        _file.numOfChunks,
        _file.createdAt,
        _file.updatedAt,
      ],
    );
    if (!ok) {
      throw new Error(`Create collection file "${file.name}" failed`);
    }
    set((state) => ({
      collectionChangedAt: date2unix(new Date()),
    }));
    return _file as ICollectionFile;
  },
  deleteFile: async (id) => {
    const ok = await window.electron.db.run(
      `DELETE FROM knowledge_files WHERE id = ?`,
      [id],
    );
    if (!ok) {
      throw new Error(`Delete knowledge file(${id}) failed`);
    }
    set((state) => ({
      collectionChangedAt: date2unix(new Date()),
      chunks: omitBy(
        state.chunks,
        (chunk: IKnowledgeChunk) => chunk.fileId === id,
      ),
    }));
    debug(`Delete knowledge file(${id}) success`);
    return true;
  },
  getFiles: async (fileIds) => {
    return (await window.electron.db.all(
      `
    SELECT
      id,
      name,
      size,
      numOfChunks,
      createdAt,
      updatedAt
    FROM
      knowledge_files
    WHERE
      id IN (${fileIds.map((f) => `'${f}'`).join(',')})
    ORDER BY
      updatedAt DESC`,
      [],
    )) as ICollectionFile[];
  },
  listFiles: async (collectionId: string) => {
    return (await window.electron.db.all(
      `
    SELECT
      id,
      name,
      size,
      numOfChunks,
      createdAt,
      updatedAt
    FROM
      knowledge_files
    WHERE
      collectionId = ?
    ORDER BY
      updatedAt DESC`,
      [collectionId],
    )) as ICollectionFile[];
  },
}));

export default useKnowledgeStore;
