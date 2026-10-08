import { Tooltip } from '@fluentui/react-components';
import { isNil } from 'lodash';
import { IChatModelConfig } from 'providers/types';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export default function ToolStatusIndicator(
  props: {
    model: IChatModelConfig;
    withTooltip?: boolean;
  } & any,
) {
  const { model, withTooltip, ...rest } = props;

  const originalSupport = useMemo(() => {
    if (!model.isBuiltIn || model.isFromApi || isNil(model.capabilities?.tools))
      return false;
    return true;
  }, [model.isBuiltIn, model.isFromApi, model.capabilities?.tools]);

  const actualSupport = useMemo(() => {
    return model.capabilities?.tools?.enabled || false;
  }, [model.capabilities?.tools]);

  const { t } = useTranslation();
  const tip = t(actualSupport ? 'Tool.Supported' : 'Tool.NotSupported');

  const indicator = () => {
    return (
      <div
        className={`flex text-center justify-center items-center rounded-full border ${originalSupport ? ' border-green-400 dark:border-green-800' : 'border-gray-300 dark:border-neutral-600'}`}
        style={{ width: 12, height: 12, borderStyle: 'solid' }}
      >
        {actualSupport ? (
          <div
            className="rounded-full bg-green-400 dark:bg-green-600"
            style={{ width: 8, height: 8 }}
            {...rest}
          />
        ) : (
          <div
            className="rounded-full bg-neutral-300  dark:bg-neutral-600"
            style={{ width: 8, height: 8 }}
            {...rest}
          />
        )}
      </div>
    );
  };

  return withTooltip ? (
    <Tooltip
      content={{
        children: tip,
      }}
      positioning="above-start"
      withArrow
      relationship="label"
    >
      {indicator()}
    </Tooltip>
  ) : (
    indicator()
  );
}
