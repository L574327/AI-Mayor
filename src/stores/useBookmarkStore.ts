import Debug from 'debug';
import { isNumber, isNil } from 'lodash';
import { typeid } from 'typeid-js';
import { IBookmark } from 'types/bookmark';
import { date2unix } from 'utils/util';
import { isBlank, isNotBlank } from 'utils/validators';
import { create } from 'zustand';

const debug = Debug('app:stores:useBookmarkStore');

export interface IBookmarkStore {
  activeBookmarkId: null | string;
  favorites: IBookmark[];
  bookmarks: IBookmark[];
  setActiveBookmarkId: (id: string) => void;
  createBookmark: (bookmark: IBookmark) => Promise<IBookmark>;
  updateBookmark: (
    bookmark: { id: string } & Partial<IBookmark>,
  ) => Promise<boolean>;
  deleteBookmark: (id: string) => Promise<boolean>;
  getBookmark: (id: string) => Promise<IBookmark>;
  fetchBookmarks: ({
    limit,
    offset,
    keyword,
    favorite,
  }: {
    limit?: number;
    offset?: number;
    keyword?: string;
    favorite?: boolean;
  }) => Promise<IBookmark[]>;
  loadFavorites: ({
    limit,
    offset,
  }: {
    limit?: number;
    offset?: number;
  }) => Promise<IBookmark[]>;
  loadBookmarks: ({
    limit,
    offset,
    keyword,
  }: {
    limit?: number;
    offset?: number;
    keyword?: string;
  }) => Promise<IBookmark[]>;
}

const useBookmarkStore = create<IBookmarkStore>((set, get) => ({
  activeBookmarkId: null,
  favorites: [],
  bookmarks: [],
  setActiveBookmarkId: (id: string) => {
    set({ activeBookmarkId: id });
  },
  createBookmark: async (bookmark: Partial<IBookmark>) => {
    const $bookmark = {
      id: typeid('bmk').toString(),
      ...bookmark,
      createdAt: date2unix(new Date()),
    } as IBookmark;
    const columns = Object.keys($bookmark);
    await window.electron.db.run(
      `INSERT INTO bookmarks (${columns.join(',')})
      VALUES(${'?'.repeat(columns.length).split('').join(',')})`,
      Object.values($bookmark),
    );
    set((state) => ({
      bookmarks: [...state.bookmarks, $bookmark],
    }));
    return $bookmark;
  },
  updateBookmark: async (bookmark: { id: string } & Partial<IBookmark>) => {
    const $bookmark = { id: bookmark.id } as IBookmark;
    const stats: string[] = [];
    const params: (string | number)[] = [];
    if (isNotBlank(bookmark.prompt)) {
      stats.push('prompt = ?');
      $bookmark.prompt = bookmark.prompt as string;
      params.push($bookmark.prompt);
    }
    if (isNotBlank(bookmark.reply)) {
      stats.push('reply = ?');
      $bookmark.reply = bookmark.reply as string;
      params.push($bookmark.reply);
    }
    if (isNotBlank(bookmark.model)) {
      stats.push('model = ?');
      $bookmark.model = bookmark.model as string;
      params.push($bookmark.model);
    }
    if (isNumber(bookmark.temperature)) {
      stats.push('temperature = ?');
      $bookmark.temperature = bookmark.temperature as number;
      params.push($bookmark.temperature);
    }
    if (!isNil(bookmark.memo)) {
      stats.push('memo = ?');
      $bookmark.memo = bookmark.memo as string;
      params.push($bookmark.memo);
    }
    if (!isNil(bookmark.favorite)) {
      stats.push('favorite = ?');
      $bookmark.favorite = bookmark.favorite;
      params.push($bookmark.favorite ? 1 : 0);
    }
    if (!isBlank(bookmark.reasoning)) {
      stats.push('reasoning = ?');
      $bookmark.reasoning = bookmark.reasoning as string;
      params.push($bookmark.reasoning);
    }
    if (bookmark.id && stats.length) {
      params.push($bookmark.id);
      await window.electron.db.run(
        `UPDATE bookmarks SET ${stats.join(', ')} WHERE id = ?`,
        params,
      );
      const updatedBookmarks = get().bookmarks.map((m: IBookmark) => {
        if (m.id === $bookmark.id) {
          return { ...m, ...$bookmark };
        }
        return m;
      });
      set({ bookmarks: updatedBookmarks });
      debug('Update Bookmark ', $bookmark);
      return true;
    }
    return false;
  },
  deleteBookmark: async (id: string) => {
    const ok = await window.electron.db.run(
      `DELETE FROM bookmarks WHERE id = ?`,
      [id],
    );
    if (!ok) {
      throw new Error('Delete bookmark failed');
    }
    const { bookmarks, favorites } = get();
    const index = bookmarks.findIndex((item) => item.id === id);
    if (index > -1) {
      debug(`Remove bookmark(${id}) from index: ${index})`);
      bookmarks.splice(index, 1);
      set({ bookmarks: [...bookmarks] });
    }
    const indexOfFavorite = favorites.findIndex((item) => item.id === id);
    if (indexOfFavorite > -1) {
      debug(`Remove favorite(${id}) from index: ${indexOfFavorite})`);
      favorites.splice(indexOfFavorite, 1);
      set({ favorites: [...favorites] });
    }
    return true;
  },
  getBookmark: async (id: string) => {
    const bookmark = (await window.electron.db.get(
      `SELECT id, prompt, reply, reasoning, model, temperature, memo, favorite, citedFiles, citedChunks, createdAt WHERE id = ?`,
      [id],
    )) as IBookmark;
    return bookmark;
  },
  fetchBookmarks: async ({
    limit = 20,
    offset = 0,
    keyword = '',
    favorite,
  }: {
    limit?: number;
    offset?: number;
    keyword?: string;
    favorite?: boolean;
  }) => {
    let sql = `SELECT id, prompt, reply, reasoning, model, temperature, memo, favorite, citedFiles, citedChunks, createdAt FROM bookmarks`;
    const whereClauses = [];
    const params: any[] = [];
    if (!isNil(favorite)) {
      whereClauses.push('favorite = ?');
      params.push(favorite ? 1 : 0);
    }
    if (isNotBlank(keyword)) {
      whereClauses.push(`(prompt like ? or reply like ? or memo like ?)`);
      const keywordPlaceholder = `%${keyword.trim()}%`;
      params.push(keywordPlaceholder, keywordPlaceholder, keywordPlaceholder);
    }
    params.push(limit, offset);
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    const bookmarks = (await window.electron.db.all(
      `${sql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      params,
    )) as IBookmark[];
    return bookmarks;
  },
  async loadBookmarks({ limit = 20, offset = 0, keyword }) {
    const bookmarks = await get().fetchBookmarks({ limit, offset, keyword });
    set({ bookmarks });
    return bookmarks;
  },
  async loadFavorites({ limit = 100, offset = 0 }) {
    const favorites = await get().fetchBookmarks({
      limit,
      offset,
      favorite: true,
    });
    set({ favorites });
    return favorites;
  },
}));

export default useBookmarkStore;
