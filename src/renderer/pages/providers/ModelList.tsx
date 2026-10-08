import {
  Combobox,
  Option,
  List,
  ListItem,
  ComboboxProps,
  Button,
  Skeleton,
  SkeletonItem,
} from '@fluentui/react-components';
import {
  AddCircleFilled,
  AddCircleRegular,
  bundleIcon,
  CaretRight16Regular,
} from '@fluentui/react-icons';
import { IChatModelConfig, IChatProviderConfig } from 'providers/types';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import TooltipIcon from 'renderer/components/TooltipIcon';
import useProviderStore from 'stores/useProviderStore';
import { ERROR_MODEL } from 'consts';
import useUI from 'hooks/useUI';
import ModelFormDrawer from './ModelFormDrawer';
import ModelCapabilityTag from './ModelCapabilityTag';

const AddIcon = bundleIcon(AddCircleFilled, AddCircleRegular);

export default function ModelList({ height = 400 }: { height?: number }) {
  const provider = useProviderStore(
    (state) => state.provider as IChatProviderConfig,
  );
  const { getModels } = useProviderStore();
  const { heightStyle } = useUI();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<IChatModelConfig | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<IChatModelConfig[]>([]);

  const onOptionSelect: ComboboxProps['onOptionSelect'] = (_, data) => {
    setQuery(data.optionText ?? '');
  };

  const loadModels = useCallback(async () => {
    try {
      if (provider.modelsEndpoint) {
        setLoading(true);
      }
      setModels(await getModels(provider, { withDisabled: true }));
    } finally {
      setLoading(false);
    }
  }, [provider.name, provider.models]);

  const filteredModels = useMemo(
    () =>
      models.filter((model) => {
        const label = model.label || (model.name as string);
        return (
          model.name !== ERROR_MODEL &&
          label.toLowerCase().includes(query.toLowerCase().trim())
        );
      }),
    [query, models],
  );

  useEffect(() => {
    loadModels();
    return () => {
      setLoading(false);
      setModels([]);
    };
  }, [provider?.name, provider?.models]);

  useEffect(() => {
    if (provider.modelsEndpoint && provider.apiKey && provider.apiBase) {
      loadModels();
    } else {
      setLoading(false);
      setModels([]);
    }
  }, [provider.apiKey, provider.apiBase]);

  if (loading) {
    return (
      <Skeleton>
        <div className="flex flex-col p-3 h-ful gap-3">
          <div className="flex justify-between items-center">
            <SkeletonItem style={{ width: 128 }} />
            <SkeletonItem style={{ width: 64 }} />
          </div>
          <div className="flex justify-between items-center">
            <SkeletonItem style={{ width: 158 }} />
            <div className="flex justify-end items-center gap-1">
              <SkeletonItem style={{ width: 64 }} />
              <SkeletonItem style={{ width: 64 }} />
            </div>
          </div>
          <div className="flex justify-between items-center">
            <SkeletonItem style={{ width: 108 }} />
            <SkeletonItem style={{ width: 64 }} />
          </div>
        </div>
      </Skeleton>
    );
  }

  return (
    <div>
      <div className="flex justify-start items-center gap-2 pl-4 border-b border-base">
        <Combobox
          size="small"
          freeform
          clearable
          className="flex-grow w-[100px]"
          appearance="underline"
          onOptionSelect={onOptionSelect}
          placeholder="Filter models"
          onChange={(ev) => setQuery(ev.target.value)}
          value={query}
        >
          {filteredModels.map((model: IChatModelConfig) => (
            <Option key={model.name as string} className="focus-visible:ring-0">
              {model.label || (model.name as string)}
            </Option>
          ))}
        </Combobox>
        <div className="border-l border-base py-1 px-2 flex justify-center items-center min-w-[80px]">
          <Button
            disabled={!!provider.modelsEndpoint}
            size="small"
            appearance="subtle"
            icon={<AddIcon />}
            onClick={() => {
              setSelectedModel(null);
              setFormOpen(true);
            }}
          >
            <span className="font-semibold">{t('Common.Model')}</span>
          </Button>
        </div>
      </div>
      <div
        className="overflow-y-auto"
        style={{
          height: heightStyle(height - 35),
        }}
      >
        {filteredModels.length === 0 ? (
          <div className="flex flex-col justify-center items-center h-96">
            <p className="tips">{t('Common.NoModels')}</p>
          </div>
        ) : (
          <List>
            {filteredModels.map((model) => {
              return (
                <ListItem
                  key={model.id}
                  aria-label={model.name}
                  onAction={() => {
                    setSelectedModel(model as IChatModelConfig);
                    setFormOpen(true);
                  }}
                  className="block hover:bg-stone-100 dark:hover:bg-zinc-700/25"
                >
                  <div className="pl-2 pr-4 pt-3 pb-2 border-b border-gray-100 dark:border-zinc-800/25 w-full">
                    <div className="font-medium flex justify-between gap-1 items-center mb-1">
                      <div className="flex justify-start items-center">
                        {model.isDefault ? (
                          <CaretRight16Regular className="text-gray-500 -mb-1" />
                        ) : (
                          <div className="w-[16px]" />
                        )}
                        <span
                          className={`text-sm ${model.disabled || !model.isReady ? 'text-gray-300 dark:text-gray-500' : ''}`}
                          title={model.name}
                        >
                          {model.label || model.name}
                        </span>
                        <div className="-mt-0.5">
                          <TooltipIcon
                            positioning="after"
                            tip={
                              <div>
                                <p className="font-bold mb-1 text-base">
                                  {model.name}
                                </p>
                                {model.extras?.modelId && (
                                  <p className="text-sm text-gray-500 mb-1">
                                    {model.extras.modelId}
                                  </p>
                                )}
                                <p>{model.description}</p>
                              </div>
                            }
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-1">
                        <ModelCapabilityTag model={model} capability="vision" />
                        <ModelCapabilityTag model={model} capability="tools" />
                      </div>
                    </div>
                  </div>
                </ListItem>
              );
            })}
          </List>
        )}
      </div>
      <ModelFormDrawer
        open={formOpen}
        setOpen={setFormOpen}
        model={selectedModel}
        models={models}
        onSaved={() => {}}
      />
    </div>
  );
}
