import Debug from 'debug';
import { typeid } from 'typeid-js';
import { IUsage, IUsageStatistics } from 'types/usage';
import { date2unix } from 'utils/util';
import { create } from 'zustand';
import useProviderStore from './useProviderStore';

const debug = Debug('app:stores:useUsageStore');

export interface IUsageStore {
  create: (usage: Partial<IUsage>) => Promise<IUsage>;
  statistics: (
    startDateUnix: number,
    endDateUnix: number,
  ) => Promise<IUsageStatistics[]>;
}
const { getAvailableModel } = useProviderStore.getState();
const getModelPrice = (
  providerName: string,
  modelName: string,
  type: 'input' | 'output',
) => {
  if (type === 'input') {
    return getAvailableModel(providerName, modelName).inputPrice;
  }
  return getAvailableModel(providerName, modelName).outputPrice;
};

const useUsageStore = create<IUsageStore>(() => ({
  create: async (usage: Partial<IUsage>) => {
    const $usage = {
      ...usage,
      id: typeid('usg').toString(),
      createdAt: date2unix(new Date()),
    } as IUsage;
    debug('Create a usage ', $usage);
    const ok = await window.electron.db.run(
      `INSERT INTO usages (id, provider,model, inputTokens, outputTokens, inputPrice, outputPrice,createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        $usage.id,
        $usage.provider,
        $usage.model,
        $usage.inputTokens,
        $usage.outputTokens,
        getModelPrice($usage.provider, $usage.model, 'input'),
        getModelPrice($usage.provider, $usage.model, 'output'),
        $usage.createdAt,
      ],
    );
    if (!ok) {
      throw new Error('Write the usage into database failed');
    }
    return $usage;
  },
  statistics: async (startDateUnix: number, endDateUnix: number) => {
    return (await window.electron.db.all(
      `
    SELECT
      provider,
      model,
      sum(inputTokens) inputTokens,
      sum(outputTokens) outputTokens,
      round(sum(inputTokens * inputPrice / 1000), 4) AS inputCost,
      round(sum(outputTokens * outputPrice / 1000), 4) AS outputCost
    FROM
      usages
    WHERE
      createdAt >= ? AND createdAt <= ?
    GROUP BY
      provider, model`,
      [startDateUnix, endDateUnix],
    )) as IUsageStatistics[];
  },
}));

export default useUsageStore;
