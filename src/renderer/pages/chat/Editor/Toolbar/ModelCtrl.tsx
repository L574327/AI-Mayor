import {
  Button,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { ChevronDownRegular } from '@fluentui/react-icons';
import { IChat, IChatContext } from 'intellichat/types';
import { find } from 'lodash';
import Mousetrap from 'mousetrap';
import { IChatModelConfig, IChatProviderConfig } from 'providers/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Spinner from 'renderer/components/Spinner';
import ToolStatusIndicator from 'renderer/components/ToolStatusIndicator';
import { captureException } from 'renderer/logging';
import useChatStore from 'stores/useChatStore';
import useProviderStore from 'stores/useProviderStore';

const MAX_MODELS = 15;

export default function ModelCtrl({
  chat,
  ctx,
}: {
  chat: IChat;
  ctx: IChatContext;
}) {
  const { t } = useTranslation();
  const editStage = useChatStore((state) => state.editStage);
  const { getAvailableProviders, getModels } = useProviderStore();
  const providers = useMemo(() => {
    return getAvailableProviders().filter((provider) => !provider.disabled);
  }, [getAvailableProviders]);
  const [query, setQuery] = useState('');
  const [curProvider, setCurProvider] = useState<IChatProviderConfig>();
  const [curModel, setCurModel] = useState<IChatModelConfig>();
  const [models, setModels] = useState<IChatModelConfig[]>([]);
  const isChanged = useRef(false);
  const [isModelsLoaded, setIsModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [menuModelOpen, setMenuModelOpen] = useState(false);
  const [menuProviderOpen, setMenuProviderOpen] = useState(false);
  const abortController = useRef<AbortController | null>(null);

  const filteredModels = useMemo(() => {
    return models
      .filter((model) => {
        if (query.trim() === '') {
          return true;
        }
        const searchTerm = query.toLowerCase();
        return (
          model.name.toLowerCase().includes(searchTerm) ||
          model.label?.toLowerCase().includes(searchTerm)
        );
      })
      .splice(0, MAX_MODELS);
  }, [query, models]);

  const loadModels = useCallback(
    async function (provider: IChatProviderConfig) {
      setIsModelsLoaded(false);
      setLoading(true);
      setModels([]);
      if (abortController.current) {
        abortController.current.abort();
      }
      abortController.current = new AbortController();
      try {
        const $models = await getModels(provider, {
          signal: abortController.current.signal,
        });
        setModels($models);
        const defaultModel = find($models, { isDefault: true }) || $models[0];
        const ctxProvider = ctx.getProvider();
        const ctxModel = ctx.getModel();
        if (ctxProvider?.name === provider.name) {
          const $model = find($models, { name: ctxModel.name });
          if ($model) {
            setCurModel($model);
            setIsModelsLoaded(true);
            setLoading(false);
            return;
          }
        } else {
          editStage(chat.id, {
            provider: provider.name,
            model: defaultModel.name,
          });
        }
        setCurModel(defaultModel);
        setIsModelsLoaded(true);
        setLoading(false);
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return;
        }
        captureException(err);
        setIsModelsLoaded(false);
        setLoading(false);
      }
    },
    [chat.id, getModels],
  );

  useEffect(() => {
    isChanged.current = false;
    const ctxProvider = ctx.getProvider();
    setCurProvider(ctxProvider);
    setCurModel(ctx.getModel());
    loadModels(ctxProvider);
    return () => {
      setCurProvider(undefined);
      setCurModel(undefined);
      setModels([]);
    };
  }, [chat.id, chat.provider, chat.model]);

  useEffect(() => {
    if (curProvider) {
      loadModels(curProvider);
    } else {
      setModels([]);
    }
  }, [curProvider?.name]);

  useEffect(() => {
    if (chat.provider !== '' && curProvider?.name !== chat.provider) {
      return;
    }
    const shouldTriggerChange =
      isModelsLoaded &&
      curProvider &&
      curModel &&
      models.some((m) => m.name === curModel.name);
    if (shouldTriggerChange && isChanged.current) {
      editStage(chat.id, {
        provider: curProvider.name,
        model: curModel.name,
      });
      isChanged.current = false;
    }
  }, [curProvider?.name, curModel?.name, isModelsLoaded]);

  useEffect(() => {
    Mousetrap.bind('mod+shift+0', () => {
      setMenuModelOpen(false);
      setMenuProviderOpen(true);
    });
    return () => {
      Mousetrap.unbind('mod+shift+0');
    };
  }, [menuProviderOpen]);

  useEffect(() => {
    Mousetrap.bind('mod+shift+1', () => {
      setMenuProviderOpen(false);
      setMenuModelOpen(true);
    });
    return () => {
      Mousetrap.unbind('mod+shift+1');
    };
  }, [menuModelOpen]);

  return (
    <div className="flex flex-start items-center -ml-1.5">
      <Menu
        open={menuProviderOpen}
        onOpenChange={(_, data) => setMenuProviderOpen(data.open)}
      >
        <MenuTrigger disableButtonEnhancement>
          <Button
            title={`${t('Common.Provider')}(Mod+Shift+0)`}
            size="small"
            appearance="transparent"
            iconPosition="after"
            className="justify-start focus-visible:ring-0 focus:right-0 border-none"
            style={{
              padding: '0 4px',
              border: 0,
              boxShadow: 'none',
              minWidth: '8px',
            }}
            icon={
              <ChevronDownRegular
                className="w-3"
                style={{ marginBottom: -2 }}
              />
            }
          >
            {curProvider?.name}
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {providers.map((provider) => (
              <MenuItem
                key={provider.name}
                style={{
                  fontSize: 12,
                  paddingTop: 1,
                  paddingBottom: 1,
                  minHeight: 12,
                }}
                disabled={!provider.isReady}
                onClick={() => {
                  isChanged.current = true;
                  setIsModelsLoaded(false);
                  setCurProvider(provider);
                }}
              >
                <div className="flex justify-start items-center gap-1 text-sm py-0.5">
                  <span>{provider.name}</span>
                  {curProvider?.name === provider.name && <span>✓</span>}
                </div>
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
      <div className="text-gray-400">/</div>
      <Menu
        open={menuModelOpen}
        onOpenChange={(_, data) => setMenuModelOpen(data.open)}
      >
        <MenuTrigger disableButtonEnhancement>
          <Button
            title={`${t('Common.Model')}(Mod+Shift+1)`}
            style={{
              padding: '0 4px',
              border: 0,
              boxShadow: 'none',
              minWidth: '10px',
            }}
            size="small"
            appearance="transparent"
            iconPosition="after"
            icon={<ChevronDownRegular className="w-3" />}
            className="flex justify-start items-center"
          >
            <div className="overflow-hidden text-ellipsis whitespace-nowrap">
              {loading ? (
                <div className="flex items-center gap-1">
                  <Spinner size={12} />
                  {t('Common.Loading')}
                </div>
              ) : (
                curModel?.label || curModel?.name
              )}
            </div>
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {models.length > MAX_MODELS && (
              <MenuItem disabled>
                <Field>
                  <Input
                    size="small"
                    placeholder={t('Common.Search')}
                    onInput={(e) => {
                      setQuery((e.target as HTMLInputElement).value);
                    }}
                  />
                </Field>
              </MenuItem>
            )}
            {models.length > 0 ? (
              filteredModels.map((model: IChatModelConfig) => (
                <MenuItem
                  key={model.name}
                  disabled={!model.isReady}
                  style={{
                    paddingTop: 2,
                    paddingBottom: 2,
                    minHeight: 12,
                    maxWidth: 500,
                  }}
                  onClick={() => {
                    isChanged.current = true;
                    setCurModel(model);
                  }}
                >
                  <div className="flex justify-start items-center gap-1 text-sm py-1">
                    <ToolStatusIndicator model={model} withTooltip />
                    <div className="-mt-[3px] overflow-x-hidden text-ellipsis whitespace-nowrap max-w-32 sm:max-w-64">
                      <span> {model.label || model.name}</span>
                      {curModel?.name === model.name && <span>✓</span>}
                    </div>
                  </div>
                </MenuItem>
              ))
            ) : (
              <MenuItem disabled>{t('Common.NoModels')}</MenuItem>
            )}
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}
