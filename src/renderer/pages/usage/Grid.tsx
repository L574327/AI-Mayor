import {
  DataGridBody,
  DataGridRow,
  DataGrid,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridCell,
  TableCellLayout,
  TableColumnDefinition,
  createTableColumn,
  useFluent,
  useScrollbarWidth,
} from '@fluentui/react-components';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IUsageStatistics } from 'types/usage';
import useProviderStore from 'stores/useProviderStore';
import { ProviderType } from '../../../providers/types';

type modelCell = {
  value: string;
};

type inputUsageCell = {
  tokens: number;
  cost: number;
};

type outputUsageCell = {
  tokens: number;
  cost: number;
};

type totalCell = {
  cost: number;
};

type Item = {
  model: modelCell;
  inputUsage: inputUsageCell;
  outputUsage: outputUsageCell;
  total: totalCell;
};

export default function Grid({
  provider,
  statistics,
}: {
  provider: ProviderType;
  statistics: IUsageStatistics[];
}) {
  const { t } = useTranslation();
  const { getAvailableProvider } = useProviderStore();
  const currencySymbol = useMemo(() => {
    const $provider = getAvailableProvider(provider);
    return $provider?.currency === 'USD' ? '$' : '¥';
  }, [provider]);
  const columns: TableColumnDefinition<Item>[] = [
    createTableColumn<Item>({
      columnId: 'model',
      compare: (a, b) => {
        return a.model.value.localeCompare(b.model.value);
      },
      renderHeaderCell: () => {
        return t('Common.Model');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout className="latin text-nowrap overflow-hidden text-ellipsis">
            <div title={item.model.value}>{item.model.value}</div>
          </TableCellLayout>
        );
      },
    }),
    createTableColumn<Item>({
      columnId: 'inputUsage',
      renderHeaderCell: () => {
        return t('Common.InputUsage');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout>
            <span className="latin">{item.inputUsage.tokens.toFixed(2)}K</span>
            <span className="text-slate-400">&nbsp;/&nbsp;</span>
            <span className="latin">
              ~{currencySymbol}
              {item.inputUsage.cost ? item.inputUsage.cost.toFixed(4) : 0}
            </span>
          </TableCellLayout>
        );
      },
    }),
    createTableColumn<Item>({
      columnId: 'outputUsage',
      renderHeaderCell: () => {
        return t('Common.OutputUsage');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout>
            <span className="latin">{item.outputUsage.tokens.toFixed(2)}K</span>
            <span className="text-slate-400">&nbsp;/&nbsp;</span>
            <span className="latin">
              ~{currencySymbol}
              {item.outputUsage.cost ? item.outputUsage.cost.toFixed(4) : 0}
            </span>
          </TableCellLayout>
        );
      },
    }),
    createTableColumn<Item>({
      columnId: 'total',
      compare: (a, b) => {
        return a.total.cost || 0 - b.total.cost || 0;
      },
      renderHeaderCell: () => {
        return t('Common.Cost');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout>
            <span className="number">
              ~{currencySymbol}
              {item.total.cost ? item.total.cost.toFixed(3) : 0}
            </span>
          </TableCellLayout>
        );
      },
    }),
  ];

  const { targetDocument } = useFluent();
  const scrollbarWidth = useScrollbarWidth({ targetDocument });

  const items = useMemo(() => {
    const $items = statistics.map((statistic: IUsageStatistics) => {
      return {
        model: { value: statistic.model },
        inputUsage: {
          tokens: Math.round((statistic.inputTokens / 1000) * 100) / 100,
          cost: statistic.inputCost,
        },
        outputUsage: {
          tokens: Math.round((statistic.outputTokens / 1000) * 100) / 100,
          cost: statistic.outputCost,
        },
        total: {
          cost:
            Math.round((statistic.inputCost + statistic.outputCost) * 1000) /
            1000,
        },
      };
    });
    const totalItem = $items.reduce(
      (acc: any, cur: any) => {
        acc.inputUsage.tokens += cur.inputUsage.tokens;
        acc.inputUsage.cost += cur.inputUsage.cost;
        acc.outputUsage.tokens += cur.outputUsage.tokens;
        acc.outputUsage.cost += cur.outputUsage.cost;
        acc.total.cost += cur.total.cost;
        return acc;
      },
      {
        model: { value: t('Common.Total') },
        inputUsage: {
          tokens: 0,
          cost: 0,
        },
        outputUsage: {
          tokens: 0,
          cost: 0,
        },
        total: {
          cost: 0,
        },
      },
    );
    return [...$items, totalItem];
  }, [statistics, t]);

  return (
    <div className="w-full mb-5">
      <h1 className="ml-1.5 text-xl font-bold pb-2">
        <span className="font-bold">{provider}</span>
      </h1>
      <DataGrid
        items={items}
        columns={columns}
        focusMode="cell"
        size="small"
        className="w-full"
      >
        <DataGridHeader style={{ paddingRight: scrollbarWidth }}>
          <DataGridRow>
            {({ renderHeaderCell }) => (
              <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
            )}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<Item>>
          {({ item, rowId }) => (
            <DataGridRow<Item> key={rowId}>
              {({ renderCell }) => (
                <DataGridCell>{renderCell(item)}</DataGridCell>
              )}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>
    </div>
  );
}
