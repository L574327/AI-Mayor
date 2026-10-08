import {
  Button,
  Field,
  SpinButton,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SpinButtonChangeEvent,
  SpinButtonOnChangeData,
  PopoverProps,
} from '@fluentui/react-components';
import Mousetrap from 'mousetrap';
import {
  bundleIcon,
  NumberSymbolSquare20Filled,
  NumberSymbolSquare20Regular,
} from '@fluentui/react-icons';
// import Debug from 'debug';
import { IChat, IChatContext } from 'intellichat/types';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useChatStore from 'stores/useChatStore';
import { str2int } from 'utils/util';
import { DEFAULT_MAX_TOKENS, MAX_TOKENS } from 'consts';

// const debug = Debug('app:pages:chat:Editor:Toolbar:MaxTokensCtrl');

const NumberSymbolSquareIcon = bundleIcon(
  NumberSymbolSquare20Filled,
  NumberSymbolSquare20Regular,
);

/**
 * Props for the MaxTokensCtrl component
 * @typedef {Object} MaxTokensCtrlProps
 * @property {IChatContext} ctx - The chat context containing model and provider information
 * @property {IChat} chat - The current chat object
 * @property {() => void} onConfirm - Callback function called when max tokens value is confirmed
 * @property {boolean} disabled - Whether the control is disabled
 */

/**
 * A popover control component for setting the maximum number of tokens in chat conversations.
 * Displays a button with the current max tokens value and provides a spin button interface
 * for adjusting the value within model-specific limits.
 * 
 * @param {MaxTokensCtrlProps} props - The component props
 * @returns {JSX.Element} The rendered MaxTokensCtrl component
 */
export default function MaxTokensCtrl({
  ctx,
  chat,
  onConfirm,
  disabled,
}: {
  ctx: IChatContext;
  chat: IChat;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const editStage = useChatStore((state) => state.editStage);

  /**
   * Calculates the maximum tokens allowed by the current model.
   * Falls back to the global MAX_TOKENS constant if model doesn't specify a limit.
   */
  const modelMaxTokens = useMemo(() => {
    const model = ctx.getModel();
    if (model && model.maxTokens) {
      return model.maxTokens;
    }
    return MAX_TOKENS;
  }, [chat.model]);

  /**
   * Calculates the current effective max tokens value, ensuring it doesn't exceed
   * the model's maximum token limit.
   */
  const curMaxTokens = useMemo<number>(() => {
    return Math.min(chat.maxTokens || MAX_TOKENS, modelMaxTokens);
  }, [chat.id, chat.model]);

  const [maxTokens, setMaxTokens] = useState<number>(curMaxTokens);

  useEffect(() => {
    Mousetrap.bind('mod+shift+4', () => {
      setOpen((prevOpen) => {
        return !prevOpen;
      });
    });
    setMaxTokens(curMaxTokens || DEFAULT_MAX_TOKENS);
    return () => {
      Mousetrap.unbind('mod+shift+4');
    };
  }, [chat.id, curMaxTokens]);

  /**
   * Handles the popover open/close state changes.
   * 
   * @param {Event} e - The DOM event that triggered the state change
   * @param {Object} data - The popover data containing open state
   */
  const handleOpenChange: PopoverProps['onOpenChange'] = (e, data) =>
    setOpen(data.open || false);

  /**
   * Updates the max tokens value when the spin button value changes.
   * Validates the input against model limits and updates the chat store.
   * 
   * @param {SpinButtonChangeEvent} ev - The spin button change event
   * @param {SpinButtonOnChangeData} data - The spin button change data containing the new value
   */
  const updateMaxTokens = async (
    ev: SpinButtonChangeEvent,
    data: SpinButtonOnChangeData,
  ) => {
    const value = data.value
      ? data.value
      : str2int(data.displayValue as string);
    const $maxToken = Math.max(Math.min(value as number, modelMaxTokens), 1);
    await editStage(chat.id, { maxTokens: $maxToken });
    setMaxTokens($maxToken);
    onConfirm();
    window.electron.ingestEvent([{ app: 'modify-max-tokens' }]);
  };

  return (
    <Popover open={open} trapFocus withArrow onOpenChange={handleOpenChange}>
      <PopoverTrigger>
        <Button
          disabled={disabled}
          size="small"
          title={`${t('Common.MaxTokens')}(Mod+Shift+4)`}
          aria-label={t('Common.MaxTokens')}
          appearance="subtle"
          onClick={() => setOpen((prevOpen) => !prevOpen)}
          icon={<NumberSymbolSquareIcon />}
          className={`justify-start text-color-secondary flex-shrink-0 ${disabled ? 'opacity-50' : ''}`}
          style={{
            padding: 1,
            minWidth: 20,
            borderColor: 'transparent',
            boxShadow: 'none',
          }}
        >
          {maxTokens || null}
        </Button>
      </PopoverTrigger>
      <PopoverSurface aria-labelledby="max tokens">
        <div className="w-64">
          <Field
            label={`${t('Common.MaxTokens')}(≤${modelMaxTokens})`}
            style={{ borderColor: 'transparent', boxShadow: 'none' }}
          >
            <SpinButton
              precision={0}
              step={1}
              min={1}
              max={modelMaxTokens}
              value={maxTokens}
              id="maxTokens"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              placeholder={`${
                t('Common.NoMoreThan') as string
              } ${modelMaxTokens}`}
              onChange={updateMaxTokens}
            />
          </Field>
          <div className="mt-1.5 text-xs tips">
            {t(`Toolbar.Tip.MaxTokens`)}
          </div>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
