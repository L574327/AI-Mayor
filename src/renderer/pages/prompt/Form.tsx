import {
  Button,
  Combobox,
  Option,
  Divider,
  Field,
  Input,
  Text,
  InputOnChangeData,
  InfoLabel,
  OptionGroup,
} from '@fluentui/react-components';
import { BracesVariable20Regular } from '@fluentui/react-icons';
import useToast from 'hooks/useToast';
import { IPromptDef } from 'intellichat/types';
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import usePromptStore from 'stores/usePromptStore';
import { parseVariables } from 'utils/util';
import { isBlank } from 'utils/validators';
import useProviderStore, { ModelOption } from 'stores/useProviderStore';

/**
 * A form field component for entering message content with variable detection and display.
 * Renders a textarea input with detected variables shown as tags below the field.
 * 
 * @param {Object} props - The component props
 * @param {string} props.label - The label text for the field
 * @param {string} [props.tooltip] - Optional tooltip text to display with the label
 * @param {string} props.value - The current value of the textarea
 * @param {function} props.onChange - Callback function called when the textarea value changes
 * @param {string[]} props.variables - Array of variable names detected in the message content
 * @returns {JSX.Element} The rendered message field component
 */
function MessageField({
  label,
  tooltip,
  value,
  onChange,
  variables,
}: {
  label: string;
  tooltip?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  variables: string[];
}) {
  const { t } = useTranslation();
  return (
    <div>
      <Field
        label={tooltip ? <InfoLabel info={tooltip}>{label}</InfoLabel> : label}
      >
        <textarea
          className="fluent"
          style={{ minHeight: 180, resize: 'vertical' }}
          onChange={onChange}
          value={value}
        />
        <Text size={200} className="text-color-secondary mt-1">
          {t('Prompt.Form.Tooltip.Variable')}
        </Text>
      </Field>
      {variables.length ? (
        <Divider className="mt-2.5 mb-1.5">
          {label}
          {t('Common.Variables')}
          &nbsp;({variables.length})
        </Divider>
      ) : null}
      <div className="flex justify-start items-center gap-2 flex-wrap">
        {variables.map((variable: string) => (
          <div
            key={variable}
            className="tag-variable px-2.5 py-1.5 flex items-center justify-start"
          >
            <BracesVariable20Regular />
            &nbsp;{variable}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A form component for creating and editing prompts.
 * Handles prompt creation, editing, validation, and saving with support for model selection,
 * system and user messages, and automatic variable detection.
 * 
 * @returns {JSX.Element} The rendered form component
 */
export default function Form() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { getGroupedModelOptions } = useProviderStore();
  const [name, setName] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [systemMessage, setSystemMessage] = useState<string>('');
  const [userMessage, setUserMessage] = useState<string>('');
  const [systemVariables, setSystemVariables] = useState<string[]>([]);
  const [userVariables, setUserVariables] = useState<string[]>([]);
  const createPrompt = usePromptStore((state) => state.createPrompt);
  const updatePrompt = usePromptStore((state) => state.updatePrompt);
  const getPrompt = usePromptStore((state) => state.getPrompt);
  const { notifyInfo, notifySuccess, notifyError } = useToast();
  const [modelOptions, setModelOptions] = useState<{
    [key: string]: ModelOption[];
  }>({});

  /**
   * Computes the display labels for selected models by combining group and option labels.
   * @returns {string[]} Array of formatted model labels in the format "group/label"
   */
  const selectedModelLabels = useMemo(() => {
    return Object.keys(modelOptions).reduce((acc, group) => {
      const options = modelOptions[group].filter((option) =>
        models.includes(option.name),
      );
      if (options.length) {
        acc.push(...options.map((option) => `${group}/${option.label}`));
      }
      return acc;
    }, [] as string[]);
  }, [modelOptions, models]);

  type PromptPayload = { id: string } & Partial<IPromptDef>;

  /**
   * Loads available model options from the provider store and updates the component state.
   */
  const loadModels = useCallback(async () => {
    const options = await getGroupedModelOptions();
    setModelOptions(options);
  }, []);

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    if (id) {
      getPrompt(id)
        .then(($prompt) => {
          setName($prompt.name || '');
          setModels($prompt.models || []);
          setSystemMessage($prompt.systemMessage || '');
          setUserMessage($prompt.userMessage || '');
          return $prompt;
        })
        .catch(() => {
          notifyError(t('Prompt.Notifications.PromptNotFound'));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setSystemVariables(parseVariables(systemMessage));
  }, [systemMessage]);

  useEffect(() => {
    setUserVariables(parseVariables(userMessage));
  }, [userMessage]);

  /**
   * Handles changes to the system message textarea.
   * @param {any} e - The change event from the textarea
   */
  const onSystemMessageChange = (e: any) => {
    setSystemMessage(e.target.value);
  };

  /**
   * Handles changes to the user message textarea.
   * @param {any} e - The change event from the textarea
   */
  const onUserMessageChange = (e: any) => {
    setUserMessage(e.target.value);
  };

  /**
   * Handles model selection changes in the combobox.
   * @param {any} e - The selection event
   * @param {any} data - The selection data containing selectedOptions
   */
  const onModelSelect = (e: any, data: any) => {
    setModels(data.selectedOptions);
  };

  /**
   * Validates and saves the prompt data.
   * Performs validation checks for required fields and either creates a new prompt
   * or updates an existing one based on the presence of an ID.
   */
  const onSave = async () => {
    const $prompt = {
      id,
      name,
      userMessage,
      models,
      userVariables,
    } as PromptPayload;
    $prompt.systemMessage = systemMessage;
    $prompt.systemVariables = systemVariables;
    if (isBlank($prompt.name)) {
      notifyInfo(t('Notification.NameRequired'));
      return;
    }
    if (isBlank($prompt.userMessage) && isBlank($prompt.systemMessage)) {
      notifyInfo(t('Prompt.Notifications.MessageRequired'));
      return;
    }
    if ($prompt.id) {
      await updatePrompt($prompt);
      notifySuccess(t('Prompt.Notifications.PromptUpdated'));
    } else {
      await createPrompt($prompt);
      notifySuccess(t('Prompt.Notifications.PromptCreated'));
    }

    navigate(-1);
  };

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.Prompts')}</h1>
          <div className="flex items-center justify-end gap-2">
            <Button appearance="subtle" onClick={() => navigate(-1)}>
              {t('Common.Cancel')}
            </Button>
            <Button appearance="primary" onClick={onSave}>
              {t('Common.Save')}
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        <div className="mr-5 flex flex-col">
          <div>
            <div className="mb-2.5">
              <Field label={t('Common.Name')}>
                <Input
                  value={name}
                  placeholder={t('Common.Required')}
                  onChange={(
                    ev: ChangeEvent<HTMLInputElement>,
                    data: InputOnChangeData,
                  ) => setName(data.value || '')}
                />
              </Field>
            </div>
            <div className="mb-2.5">
              <Field label={t('Prompt.Form.ApplicableModels')}>
                <Combobox
                  aria-labelledby="models"
                  multiselect
                  placeholder={
                    selectedModelLabels.length
                      ? selectedModelLabels.join(', ')
                      : t('Common.Optional')
                  }
                  selectedOptions={models}
                  onOptionSelect={onModelSelect}
                >
                  {Object.keys(modelOptions).map((group: string) => (
                    <OptionGroup label={group} key={group}>
                      {modelOptions[group].map(
                        (option: { name: string; label: string }) => (
                          <Option
                            key={`${group}-${option.name}`}
                            aria-label={option.label}
                            text={option.label}
                            value={option.name}
                          >
                            {option.label || option.name}
                          </Option>
                        ),
                      )}
                    </OptionGroup>
                  ))}
                </Combobox>
              </Field>
              <Text size={200} className="text-color-secondary">
                {t('Prompt.Form.Tooltip.ApplicableModels')}
              </Text>
            </div>
            <div className="mb-2.5">
              <MessageField
                label={t('Common.SystemMessage')}
                tooltip={t('Tooltip.SystemMessage')}
                value={systemMessage}
                onChange={onSystemMessageChange}
                variables={systemVariables}
              />
            </div>
            <div className="mb-2.5">
              <MessageField
                label={t('Common.UserMessage')}
                value={userMessage}
                onChange={onUserMessageChange}
                variables={userVariables}
              />
            </div>
          </div>
        </div>
        <div className="h-16" />
      </div>
    </div>
  );
}
