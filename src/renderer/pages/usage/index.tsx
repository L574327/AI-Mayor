// import Debug from 'debug';
import { Field } from '@fluentui/react-components';
import { DatePicker } from '@fluentui/react-datepicker-compat';
import { EARLIEST_DATE } from 'consts';
import { groupBy, isNull } from 'lodash';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Empty from 'renderer/components/Empty';
import useUsageStore from 'stores/useUsageStore';
import { IUsageStatistics } from 'types/usage';
import { date2unix } from 'utils/util';
import Grid from './Grid';
import { ProviderType } from '../../../providers/types';

// const debug = Debug('app:pages:usage');

const onFormatDate = (date?: Date): string => {
  return !date
    ? ''
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

export default function Usage() {
  const { t } = useTranslation();
  const today = useMemo(() => new Date(), []);
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(today);

  const [statistics, setStatistics] = useState<{
    [key: string]: IUsageStatistics[];
  }>({});

  useEffect(() => {
    let $startDate = startDate;
    const $endDate = endDate || today;

    if (isNull($startDate)) {
      if (endDate) {
        $startDate = new Date();
        $startDate.setDate(endDate.getDate() - 30);
        setStartDate($startDate);
      }
    }

    const loadStatistics = async () => {
      if ($startDate && $endDate) {
        $startDate.setHours(0, 0, 0, 0);
        const startDateUnix = date2unix($startDate);
        $endDate.setHours(23, 59, 59, 999);
        const endDateUnix = date2unix($endDate);
        const rows = await useUsageStore
          .getState()
          .statistics(startDateUnix, endDateUnix);
        const $statistics = groupBy(rows, 'provider');
        setStatistics($statistics);
      }
    };
    loadStatistics();
  }, [endDate, startDate, today]);

  const onStartDateChange = (date: Date | null | undefined) =>
    setStartDate(date || null);

  const onEndDateChange = (date: Date | null | undefined) =>
    setEndDate(date || null);

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">
            {t('Common.Analytics')}
          </h1>
          <div className="flex justify-end w-full items-center gap-2">
            <Field label={t('Common.StartDate')}>
              <DatePicker
                value={startDate}
                minDate={EARLIEST_DATE}
                maxDate={endDate || today}
                formatDate={onFormatDate}
                placeholder="Start  date"
                highlightCurrentMonth
                style={{ width: 130 }}
                onSelectDate={onStartDateChange}
              />
            </Field>
            <Field label={t('Common.EndDate')}>
              <DatePicker
                value={endDate}
                minDate={startDate || EARLIEST_DATE}
                maxDate={today}
                formatDate={onFormatDate}
                placeholder="End  date"
                highlightCurrentMonth
                style={{ width: 130 }}
                onSelectDate={onEndDateChange}
              />
            </Field>
          </div>
        </div>
      </div>
      <div className="mt-2.5 pb-28 h-full -mr-5 overflow-y-auto">
        {Object.keys(statistics).length ? (
          Object.keys(statistics).map((provider: string) => {
            return (
              <Grid
                statistics={statistics[provider]}
                provider={provider as ProviderType}
                key={provider}
              />
            );
          })
        ) : (
          <Empty image="usage" text={t('No data yet.')} />
        )}
      </div>
    </div>
  );
}
