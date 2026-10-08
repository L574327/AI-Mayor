import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Field,
  Label,
  Slider,
  SliderOnChangeData,
  PopoverProps,
} from '@fluentui/react-components';
import {
  bundleIcon,
  Temperature20Filled,
  Temperature20Regular,
} from '@fluentui/react-icons';
import { useState, ChangeEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useChatStore from 'stores/useChatStore';
import { IChat, IChatContext } from 'intellichat/types';
import Mousetrap from 'mousetrap';

// const debug = Debug('app:pages:chat:Editor:Toolbar:TemperatureCtrl');

const TemperatureIcon = bundleIcon(Temperature20Filled, Temperature20Regular);

export default function TemperatureCtrl({
  ctx,
  chat,
  disabled,
}: {
  ctx: IChatContext;
  chat: IChat;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const editStage = useChatStore((state) => state.editStage);
  const [maxTemperature, setMaxTemperature] = useState<number>(0);
  const [minTemperature, setMinTemperature] = useState<number>(0);
  const [temperature, setTemperature] = useState<number>(0);

  const handleOpenChange: PopoverProps['onOpenChange'] = (e, data) =>
    setOpen(data.open || false);

  useEffect(() => {
    Mousetrap.bind('mod+shift+5', () =>
      setOpen((prevOpen) => {
        return !prevOpen;
      }),
    );
    const provider = ctx.getProvider();
    if (provider) {
      setMinTemperature(provider.temperature.min);
      setMaxTemperature(provider.temperature.max);
      setTemperature(ctx.getTemperature());
    }
    return () => {
      Mousetrap.unbind('mod+shift+5');
    };
  }, [chat.id, chat.provider, chat.temperature]);

  const updateTemperature = async (
    ev: ChangeEvent<HTMLInputElement>,
    data: SliderOnChangeData,
  ) => {
    const $temperature = data.value;
    setTemperature($temperature);
    await editStage(chat.id, { temperature: $temperature });
    window.electron.ingestEvent([{ app: 'modify-temperature' }]);
  };

  return (
    <Popover trapFocus withArrow open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          disabled={disabled}
          size="small"
          title={`${t('Common.Temperature')}(Mod+Shift+5)`}
          aria-label={t('Common.Temperature')}
          appearance="subtle"
          icon={<TemperatureIcon className="mr-0" />}
          className={`justify-start text-color-secondary flex-shrink-0 ${disabled ? 'opacity-50' : ''}`}
          style={{
            padding: 1,
            minWidth: 30,
            borderColor: 'transparent',
            boxShadow: 'none',
          }}
        >
          <span className="latin">{temperature}</span>
        </Button>
      </PopoverTrigger>
      <PopoverSurface aria-labelledby="temperature">
        <div className="w-80">
          <Field label={`${t('Common.Temperature')} (${temperature})`}>
            <div className="flex items-center p-1.5">
              <Label aria-hidden>{minTemperature}</Label>
              <Slider
                id="chat-temperature"
                step={0.1}
                min={minTemperature}
                max={maxTemperature}
                value={temperature}
                className="flex-grow"
                onChange={updateTemperature}
              />
              <span>{maxTemperature}</span>
            </div>
            <div className="tips text-xs">
              {t(
                `Higher values like ${
                  maxTemperature - 0.2
                } will make the output more creative and unpredictable, while lower values like ${
                  minTemperature + 0.2
                } will make it more precise.`,
              )}
            </div>
          </Field>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
