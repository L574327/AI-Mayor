import { capitalize, isNil } from 'lodash';
import { IChatModelConfig } from 'providers/types';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export default function ModelCapabilityTag(
  props: {
    model: IChatModelConfig;
    capability: 'json' | 'tools' | 'vision';
  } & any,
) {
  const { model, capability: capabilityName } = props;

  const capability = useMemo(() => {
    return (
      model.capabilities[capabilityName as keyof typeof model.capabilities] ||
      null
    );
  }, [model]);

  const originalSupport = useMemo(() => {
    if (isNil(capability)) return false;
    return true;
  }, [capability]);

  const actualSupport = useMemo(() => {
    return capability?.enabled || false;
  }, [capability]);

  const { t } = useTranslation();

  const tagColorCls = useMemo<string>(() => {
    return (
      {
        json: 'bg-teal-50 dark:bg-teal-900 text-teal-600 dark:text-teal-300',
        tools:
          'bg-[#d8e6f1] dark:bg-[#365065] text-[#546576] dark:text-[#e3e9e5]',
        vision:
          'bg-[#e6ddee] dark:bg-[#4e3868] text-[#9e7ebd] dark:text-[#d9d4de]',
      } as { [key: string]: string }
    )[capabilityName];
  }, [capabilityName]);

  const dotColorCls = useMemo<string>(() => {
    return (
      {
        json: 'bg-teal-400 bg:text-teal-600',
        tools: 'bg-[#546576] bg:text-[#46799f]',
        vision: 'bg-[#9e7ebd] bg:text-[#8d60c3]',
      } as { [key: string]: string }
    )[capabilityName];
  }, [capabilityName]);

  return originalSupport ? (
    <div
      style={{ fontSize: '12px' }}
      className={`flex text-center justify-start gap-1 items-center rounded-full text-xs px-2 py-[2px] ${actualSupport ? tagColorCls : 'bg-gray-100 dark:bg-zinc-700 text-gray-400 dark:text-gray-500'}`}
    >
      <div
        style={{ fontSize: '8px' }}
        className={`flex-shrink-0 w-2 h-2 rounded-full ${
          actualSupport
            ? dotColorCls
            : 'border border-gray-400 bg:border-gray-500'
        }`}
      />
      <span className="-mt-0.5">{t(`Tags.${capitalize(capabilityName)}`)}</span>
    </div>
  ) : null;
}
