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
  AttachText20Regular,
  AttachText20Filled,
} from '@fluentui/react-icons';
import { useState, ChangeEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useChatStore from 'stores/useChatStore';
// import Debug from 'debug';
import { IChat, IChatContext } from 'intellichat/types';
import Mousetrap from 'mousetrap';
import { isNumber } from 'lodash';
import { MIN_CTX_MESSAGES, MAX_CTX_MESSAGES, NUM_CTX_MESSAGES } from 'consts';

// const debug = Debug('app:pages:chat:Editor:Toolbar:CtxNumCtrl');

const AttacheTextIcon = bundleIcon(AttachText20Filled, AttachText20Regular);

export default function CtxNumCtrl({
  ctx,
  chat,
  disabled,
}: {
  ctx:IChatContext,
  chat: IChat;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const editStage = useChatStore((state) => state.editStage);
  const [ctxMessages, setCtxMessages] = useState<number>(NUM_CTX_MESSAGES);

  const handleOpenChange: PopoverProps['onOpenChange'] = (e, data) =>
    setOpen(data.open || false);

  const updateCtxMessages = async (
    ev: ChangeEvent<HTMLInputElement>,
    data: SliderOnChangeData,
  ) => {
    const maxCtxMessages = data.value;
    setCtxMessages(maxCtxMessages);
    await editStage(chat.id, { maxCtxMessages });
    window.electron.ingestEvent([
      { app: 'modify-max-ctx-messages' },
      { 'max-ctx-messages': maxCtxMessages },
    ]);
  };

  useEffect(() => {
    Mousetrap.bind('mod+shift+6', () =>
      setOpen((prevOpen) => {
        return !prevOpen;
      }),
    );
    setCtxMessages(
      isNumber(chat.maxCtxMessages) ? chat.maxCtxMessages : NUM_CTX_MESSAGES,
    );
    return () => {
      Mousetrap.unbind('mod+shift+6');
    };
  }, [chat.id]);

  return (
    <Popover trapFocus withArrow open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          size="small"
          title={`${t('Common.NumberOfContextMessages')}(Mod+Shift+6)`}
          aria-label={t('Common.NumberOfContextMessages')}
          appearance="subtle"
          icon={<AttacheTextIcon className="mr-0" />}
          className={`justify-start text-color-secondary flex-shrink-0 ${disabled ? 'opacity-50' : ''}`}
          disabled={disabled}
          style={{
            padding: 1,
            minWidth: 30,
            borderColor: 'transparent',
            boxShadow: 'none',
          }}
        >
          <span className="latin">{ctxMessages}</span>
        </Button>
      </PopoverTrigger>
      <PopoverSurface aria-labelledby="temperature">
        <div className="w-80">
          <Field
            label={`${t('Common.MaxNumOfContextMessages')} (${ctxMessages})`}
          >
            <div className="flex items-center p-1.5">
              <Label aria-hidden>{MIN_CTX_MESSAGES}</Label>
              <Slider
                id="chat-max-context"
                step={3}
                min={MIN_CTX_MESSAGES}
                max={MAX_CTX_MESSAGES}
                value={ctxMessages}
                className="flex-grow"
                onChange={updateCtxMessages}
              />
              <Label aria-hidden>{MAX_CTX_MESSAGES}</Label>
            </div>
          </Field>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
