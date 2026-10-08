import Debug from 'debug';
import { IPromptDef } from 'intellichat/types';
import { isNil, isNumber, isUndefined } from 'lodash';
import { typeid } from 'typeid-js';

import { date2unix, sortPrompts } from 'utils/util';
import { isNotBlank } from 'utils/validators';
import { create } from 'zustand';

const debug = Debug('app:stores:usePromptStore');

export interface IPromptStore {
  prompt: IPromptDef | null;
  prompts: IPromptDef[];
  createPrompt: (prompt: Partial<IPromptDef>) => Promise<IPromptDef>;
  updatePrompt: (
    prompt: { id: string } & Partial<IPromptDef>,
  ) => Promise<boolean>;
  deletePrompt: (id: string) => Promise<boolean>;
  setPrompt: (prompt: IPromptDef | null) => void;
  getPrompt: (id: string) => Promise<IPromptDef>;
  fetchPrompts: ({
    limit, // to fetch all prompts practically
    offset,
    keyword,
  }: {
    limit?: number;
    offset?: number;
    keyword?: string;
  }) => Promise<IPromptDef[]>;
}

const usePromptStore = create<IPromptStore>((set, get) => ({
  prompt: null,
  prompts: [],
  createPrompt: async (prompt: Partial<IPromptDef>) => {
    const now = date2unix(new Date());
    const $prompt = {
      ...prompt,
      id: typeid('pmpt').toString(),
      createdAt: now,
      updatedAt: now,
    } as IPromptDef;
    const columns = Object.keys($prompt);

    const placeholders = columns.map((col) => {
      if (['systemVariables', 'userVariables', 'models'].includes(col)) {
        return 'json(?)';
      }
      return '?';
    });

    const values = columns.map((col) => {
      const $col = col as keyof IPromptDef;
      if (['systemVariables', 'userVariables', 'models'].includes(col)) {
        return JSON.stringify($prompt[$col]);
      }
      return $prompt[$col];
    });

    await window.electron.db.run(
      `INSERT INTO prompts (${columns.join(',')})
      VALUES(${placeholders.join(',')})`,
      values,
    );
    set((state) => ({
      prompts: [...state.prompts, $prompt],
    }));
    return $prompt;
  },
  updatePrompt: async (prompt: { id: string } & Partial<IPromptDef>) => {
    const $prompt = { id: prompt.id } as IPromptDef;
    const stats: string[] = [];
    const params: (string | number | null)[] = [];
    if (isNotBlank(prompt.name)) {
      stats.push('name = ?');
      $prompt.name = prompt.name as string;
      params.push($prompt.name);
    }
    if (!isNil(prompt.systemMessage)) {
      stats.push('systemMessage = ?');
      $prompt.systemMessage = prompt.systemMessage as string;
      params.push($prompt.systemMessage);
    }
    if (!isNil(prompt.userMessage)) {
      stats.push('userMessage = ?');
      $prompt.userMessage = prompt.userMessage as string;
      params.push($prompt.userMessage);
    }
    if (isNumber(prompt.temperature)) {
      stats.push('temperature = ?');
      $prompt.temperature = prompt.temperature as number;
      params.push($prompt.temperature);
    }
    if (isNumber(prompt.maxTokens)) {
      stats.push('maxTokens = ?');
      $prompt.maxTokens = prompt.maxTokens as number;
      params.push($prompt.maxTokens);
    }
    if (!isNil(prompt.systemVariables)) {
      stats.push('systemVariables = json(?)');
      $prompt.systemVariables = prompt.systemVariables as string[];
      params.push(JSON.stringify(prompt.systemVariables));
    }
    if (!isNil(prompt.userVariables)) {
      stats.push('userVariables = json(?)');
      $prompt.userVariables = prompt.userVariables as string[];
      params.push(JSON.stringify(prompt.userVariables));
    }
    if (!isNil(prompt.models)) {
      stats.push('models = json(?)');
      $prompt.models = prompt.models as string[];
      params.push(JSON.stringify(prompt.models));
    }
    if (!isUndefined(prompt.pinedAt)) {
      stats.push('pinedAt = ?');
      $prompt.pinedAt = prompt.pinedAt;
      params.push($prompt.pinedAt);
    }
    if (prompt.id && stats.length) {
      stats.push('updatedAt = ?');
      $prompt.updatedAt = date2unix(new Date());
      params.push($prompt.updatedAt);
      params.push($prompt.id);
      await window.electron.db.run(
        `UPDATE prompts SET ${stats.join(', ')} WHERE id = ?`,
        params,
      );
      const updatedPrompts = sortPrompts(
        get().prompts.map((p: IPromptDef) => {
          if (p.id === $prompt.id) {
            return { ...p, ...$prompt };
          }
          return p;
        }),
      );
      set({ prompts: updatedPrompts });
      debug('Update Prompt ', $prompt);
      return true;
    }
    return false;
  },
  deletePrompt: async (id: string) => {
    const ok = await window.electron.db.run(
      `DELETE FROM prompts WHERE id = ?`,
      [id],
    );
    if (!ok) {
      throw new Error('Delete prompt failed');
    }
    const { prompts } = get();
    const index = prompts.findIndex((item) => item.id === id);
    if (index > -1) {
      debug(`Remove prompt(${id}) from index: ${index})`);
      prompts.splice(index, 1);
      set({ prompts: [...prompts] });
    }
    return true;
  },
  getPrompt: async (id: string) => {
    const prompt = (await window.electron.db.get(
      `SELECT
       id,
       name,
       systemMessage,
       userMessage,
       maxTokens,
       temperature,
       systemVariables,
       userVariables,
       models,
       pinedAt
       FROM prompts
       WHERE id = ?`,
      [id],
    )) as any;
    prompt.systemVariables = prompt.systemVariables
      ? JSON.parse(prompt.systemVariables as string)
      : [];
    prompt.userVariables = prompt.userVariables
      ? JSON.parse(prompt.userVariables as string)
      : [];
    prompt.models = prompt.models ? JSON.parse(prompt.models as string) : [];
    return prompt as IPromptDef;
  },
  setPrompt: (prompt: IPromptDef | null) => {
    set({ prompt });
  },
  fetchPrompts: async ({
    limit = 99999,
    offset = 0,
    keyword = '',
  }: {
    limit?: number;
    offset?: number;
    keyword?: string;
  }) => {
    let sql = `SELECT
    id,
    name,
    models,
    updatedAt,
    createdAt,
    pinedAt
    FROM prompts`;
    let params: (string | number)[] = [limit, offset];
    if (isNotBlank(keyword)) {
      sql += ` WHERE name like ? `;
      params = [`%${keyword.trim()}%`, limit, offset];
    }
    const rows = await window.electron.db.all(
      `${sql} ORDER BY pinedAt DESC, createdAt ASC
       LIMIT ? OFFSET ?`,
      params,
    );
    const prompts = rows.map((row: any) => {
      row.models = row.models ? JSON.parse(row.models) : [];
      return row;
    }) as IPromptDef[];
    set({
      prompts,
    });
    return prompts;
  },
}));

export default usePromptStore;
