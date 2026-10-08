import {
  Switch,
  SwitchOnChangeData,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  PopoverProps,
  Button,
} from '@fluentui/react-components';
import { useState, ChangeEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useChatStore from 'stores/useChatStore';
import Debug from 'debug';

import { IChat, IChatContext } from 'intellichat/types';
import { Stream20Filled } from '@fluentui/react-icons';

const debug = Debug('app:pages:chat:Editor:Toolbar:StreamCtrl');

/**
 * Stream control component that provides a toggle for enabling/disabling streaming mode in chat conversations.
 * Displays a popover with a switch control and shows the current streaming state.
 * 
 * @param {Object} props - Component props
 * @param {IChatContext} props.ctx - Chat context containing stream state information
 * @param {IChat} props.chat - Current chat object
 * @returns {JSX.Element} Stream control popover component
 */
export default function StreamCtrl({
  ctx,
  chat,
}: {
  ctx: IChatContext;
  chat: IChat;
}) {
  const { t } = useTranslation();

  const editStage = useChatStore((state) => state.editStage);
  const [stream, setStream] = useState<boolean>(true);

  /**
   * Handles stream toggle changes by updating the chat stage and sending an event to the main process.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - Change event from the switch input
   * @param {SwitchOnChangeData} data - Switch component data containing the checked state
   */
  const updateStream = async (
    ev: ChangeEvent<HTMLInputElement>,
    data: SwitchOnChangeData,
  ) => {
    const $stream = data.checked;
    await editStage(chat.id, { stream: $stream });
    window.electron.ingestEvent([
      { app: 'toggle-stream', stream: $stream ? 'on' : 'off' },
    ]);
  };

  const [open, setOpen] = useState<boolean>(false);

  /**
   * Handles popover open/close state changes.
   * 
   * @param {any} e - Event object
   * @param {any} data - Popover data containing open state
   */
  const handleOpenChange: PopoverProps['onOpenChange'] = (e, data) =>
    setOpen(data.open || false);

  /**
   * Renders the label for the stream switch showing current state.
   * 
   * @returns {JSX.Element} Label element with translated text
   */
  const renderLabel = () => {
    return (
      <label className="text-xs">
        {stream
          ? t('Editor.Toolbar.StreamEnabled')
          : t('Editor.Toolbar.StreamDisabled')}
      </label>
    );
  };

  useEffect(() => {
    setStream(ctx.isStream());
  }, [ctx]);

  return (
    <Popover open={open} trapFocus withArrow onOpenChange={handleOpenChange}>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          size="small"
          aria-label={t('Editor.Toolbar.StreamMode')}
          appearance="subtle"
          icon={<Stream20Filled />}
          className="justify-start inline-block text-color-secondary"
          style={{ padding: 1, minWidth: 20 }}
        >
          {stream ? 'on' : 'off'}
        </Button>
      </PopoverTrigger>
      <PopoverSurface aria-labelledby="temperature">
        <div className="w-56">
          <Switch
            checked={stream}
            label={renderLabel()}
            onChange={updateStream}
          />
        </div>
      </PopoverSurface>
    </Popover>
  );
}
