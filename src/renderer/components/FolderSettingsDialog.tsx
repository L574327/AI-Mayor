import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  DialogBody,
  Button,
  Field,
  Dropdown,
  Option,
  Textarea,
  OptionOnSelectData,
  SelectionEvents,
  SpinButton,
  SpinButtonChangeEvent,
  SpinButtonOnChangeData,
} from '@fluentui/react-components';
import Mousetrap from 'mousetrap';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import useChatStore from 'stores/useChatStore';
import useAuthStore from 'stores/useAuthStore';
import { IChatModelConfig, IChatProviderConfig } from 'providers/types';
import { DEFAULT_TEMPERATURE, ERROR_MODEL, TEMP_CHAT_ID } from 'consts';
import useProviderStore from 'stores/useProviderStore';
import { find } from 'lodash';
import ToolStatusIndicator from './ToolStatusIndicator';

export default function FolderSettingsDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const chat = useChatStore((state) => state.chat);
  const chats = useChatStore((state) => state.chats);
  const folder = useChatStore((state) => state.folder);
  const session = useAuthStore((state) => state.session);
  const {
    getDefaultProvider,
    getAvailableProvider,
    getAvailableProviders,
    getModels,
  } = useProviderStore();
  const providers = useMemo(
    () => getAvailableProviders(),
    [folder?.id, session],
  );
  const { t } = useTranslation();
  const [models, setModels] = useState<IChatModelConfig[]>([]);
  const { updateFolder, updateChat, editStage } = useChatStore();
  const [folderProvider, setFolderProvider] = useState('');
  const [folderModel, setFolderModel] = useState('');
  const [folderSystemMessage, setFolderSystemMessage] = useState('');
  const [folderTemperature, setFolderTemperature] = useState(1);

  const provider = useMemo(
    () => getAvailableProvider(folderProvider),
    [folderProvider],
  );

  const folderModelLabel = useMemo(() => {
    if (!folderModel) return '';
    return find(models, { name: folderModel })?.label || folderModel;
  }, [folderModel, models]);

  const loadModels = useCallback(
    async (providerName: string) => {
      const $models = await getModels(getAvailableProvider(providerName));
      setModels($models);
      const $model =
        find($models, { name: folder?.model }) ||
        find($models, { isDefault: true }) ||
        $models[0];
      setFolderModel($model.name);
    },
    [folder?.id, folder?.model, models],
  );

  const subChats = useMemo(() => {
    if (!folder) return [];
    return chats.filter((c) => c.folderId === folder.id);
  }, [chats, folder]);

  const onConfirm = useCallback(async () => {
    await updateFolder({
      id: folder?.id as string,
      provider: folderProvider,
      model: folderModel,
      temperature: folderTemperature,
      systemMessage: folderSystemMessage,
    });
    if (chat.id === TEMP_CHAT_ID) {
      await editStage(chat.id, {
        provider: folderProvider,
        model: folderModel,
        temperature: folderTemperature,
        systemMessage: folderSystemMessage,
      });
    }
    await Promise.all(
      subChats.map(async (c) => {
        await updateChat({
          id: c.id,
          provider: folderProvider,
          model: folderModel,
          temperature: folderTemperature,
          systemMessage: folderSystemMessage,
        });
        return c;
      }),
    );
    setOpen(false);
  }, [
    setOpen,
    folderModel,
    folderSystemMessage,
    folderTemperature,
    folder?.id,
    subChats,
  ]);

  const onTemperatureChange = useCallback(
    (ev: SpinButtonChangeEvent, data: SpinButtonOnChangeData) => {
      const value = data.value
        ? Math.round(data.value * 10) / 10
        : Math.round(parseFloat(data.displayValue as string) * 10) / 10;
      const $temperature = Math.max(
        Math.min(value as number, provider.temperature.max),
        provider.temperature.min,
      );
      setFolderTemperature($temperature);
    },
    [folderProvider],
  );

  useEffect(() => {
    if (open) {
      let $provider = null;
      if (folder?.provider) {
        $provider = getAvailableProvider(folder.provider);
      } else {
        $provider = getDefaultProvider();
      }
      setFolderProvider($provider.name);
      if (folder?.model) {
        setFolderModel(folder.model);
      }
      setFolderSystemMessage(folder?.systemMessage || '');
      let temperature =
        folder?.temperature ||
        $provider.temperature.default ||
        DEFAULT_TEMPERATURE;
      if (
        temperature < $provider.temperature.min ||
        temperature > $provider.temperature.max
      ) {
        temperature = $provider.temperature.default || DEFAULT_TEMPERATURE;
      }
      setFolderTemperature(temperature);
      Mousetrap.bind('esc', () => setOpen(false));
    }
    return () => {
      Mousetrap.unbind('esc');
    };
  }, [open]);

  useEffect(() => {
    if (folderProvider) {
      loadModels(folderProvider);
    }
  }, [folderProvider]);

  return (
    <Dialog open={open}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{folder?.name}</DialogTitle>
          <DialogContent>
            <div className="tips mb-4">{t('Folder.Settings.Description')}</div>
            <div className="flex flex-col gap-4 w-full">
              <div className="flex justify-start gap-2">
                <Field label={t('Common.Provider')} size="small">
                  <Dropdown
                    placeholder="Select a provider"
                    style={{ minWidth: 160 }}
                    value={folderProvider}
                    onOptionSelect={(
                      _: SelectionEvents,
                      data: OptionOnSelectData,
                    ) => {
                      setFolderProvider(data.optionValue as string);
                    }}
                  >
                    {providers.map((p: IChatProviderConfig) => (
                      <Option
                        disabled={!p.isReady}
                        key={p.name as string}
                        value={p.name as string}
                        text={p.name as string}
                      >
                        <div className="flex justify-start items-center gap-1">
                          <span className="text-xs"> {p.name}</span>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label={t('Common.Model')} size="small">
                  <Dropdown
                    className="w-full"
                    style={{ minWidth: 260 }}
                    placeholder="Select a model"
                    value={folderModelLabel}
                    onOptionSelect={(
                      _: SelectionEvents,
                      data: OptionOnSelectData,
                    ) => {
                      setFolderModel(data.optionValue as string);
                    }}
                  >
                    {models.map((m: IChatModelConfig) => (
                      <Option
                        disabled={!m.isReady}
                        key={m.name as string}
                        value={m.name as string}
                        text={(m.label || m.name) as string}
                      >
                        <div className="flex justify-start items-center gap-1 text-xs">
                          <ToolStatusIndicator model={m} withTooltip />
                          <span> {m.label || m.name}</span>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <div>
                  <Field
                    size="small"
                    label={`${t('Common.Temperature')}[${provider.temperature.min},${provider.temperature.max}]`}
                  >
                    <SpinButton
                      precision={1}
                      step={0.1}
                      value={folderTemperature || DEFAULT_TEMPERATURE}
                      max={provider.temperature.max}
                      min={provider.temperature.min}
                      onChange={onTemperatureChange}
                      id="temperature"
                    />
                  </Field>
                </div>
              </div>
              <div>
                <Field label={t('Common.SystemMessage')} size="small">
                  <Textarea
                    value={folderSystemMessage}
                    rows={10}
                    onChange={(e) => setFolderSystemMessage(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle" onClick={() => setOpen(false)}>
                {t('Common.Cancel')}
              </Button>
            </DialogTrigger>
            <DialogTrigger disableButtonEnhancement>
              <Button
                appearance="primary"
                onClick={() => onConfirm()}
                disabled={folderModel === ERROR_MODEL}
              >
                {t('Common.Save')}
              </Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
