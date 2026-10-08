import React, { useEffect, useState } from 'react';
import {
  Field,
  InfoLabel,
  Input,
  Label,
  Select,
  Switch,
} from '@fluentui/react-components';
import { getChatAPISchema } from 'providers';
import { IChatProviderConfig } from 'providers/types';
import { useTranslation } from 'react-i18next';
import MaskableInput from 'renderer/components/MaskableInput';
import useProviderStore from 'stores/useProviderStore';
import { isBlank, isValidHttpHRL } from 'utils/validators';

/**
 * A form component for configuring chat provider settings.
 * Renders input fields for provider name, currency, API endpoint, proxy, API key, secret key, and API version.
 * Fields are conditionally displayed based on the provider's API schema requirements.
 * Includes real-time validation and automatic updates to the provider store.
 * 
 * @returns {JSX.Element} The provider configuration form
 */
export default function ProviderForm() {
  const { t } = useTranslation();
  const provider = useProviderStore(
    (state) => state.provider as IChatProviderConfig,
  );
  const [oldName, setOldName] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [nameError, setNameError] = useState<string>('');
  const [currency, setCurrency] = useState<string>('USD');
  const [endpoint, setEndpoint] = useState<string>('');
  const [endpointError, setEndpointError] = useState<string>('');
  const [proxy, setProxy] = useState<string>('');
  const [proxyError, setProxyError] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [secretError, setSecretError] = useState<string>('');
  const [version, setVersion] = useState<string>('');
  const [versionError, setVersionError] = useState<string>('');
  const [isDefault, setIsDefault] = useState<boolean>(false);
  const { updateProvider, isProviderDuplicated } = useProviderStore();

  useEffect(() => {
    setOldName(provider.name || '');
    setName(provider.name || '');
    setEndpoint(provider.apiBase || '');
    setProxy(provider.proxy || '');
    setApiKey(provider.apiKey || '');
    setCurrency(provider.currency || 'USD');
    setSecret(provider.apiSecret || '');
    setVersion(provider.apiVersion || '');
    setIsDefault(provider.isDefault || false);
    return () => {
      setName('');
      setEndpoint('');
      setProxy('');
      setSecret('');
      setVersion('');
      setNameError('');
      setEndpointError('');
      setProxyError('');
      setSecretError('');
      setVersionError('');
      setIsDefault(false);
      setCurrency('USD');
    };
  }, [provider]);

  return (
    <div className="provider-form w-full bg-zinc-50 dark:bg-zinc-800/10 p-4 border-b border-base">
      <div className="flex justify-around items-center gap-1 pb-1">
        <Field
          className="flex-grow min-w-[185px] -mb-0.5"
          size="small"
          validationState={nameError ? 'error' : 'none'}
          validationMessage={nameError}
        >
          <InfoLabel
            className="pt-0.5"
            size="small"
            info={
              provider.isBuiltIn
                ? t('Provider.Tooltip.NameOfBuiltinProviderIsReadyOnly')
                : t('Provider.Tooltip.NameOfProviderMustBeUnique')
            }
          >
            {t('Common.Name')}
          </InfoLabel>
          <Input
            value={name}
            disabled={provider.isBuiltIn}
            onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
              if (oldName === ev.target.value) {
                setNameError('');
                return;
              }
              if (isBlank(ev.target.value)) {
                setNameError(t('Common.Required'));
              } else if (isProviderDuplicated(ev.target.value)) {
                setNameError(t('Provider.Tooltip.NameOfProviderMustBeUnique'));
              } else {
                setNameError('');
                updateProvider(oldName, { name: ev.target.value });
                setName(ev.target.value);
                setOldName(ev.target.value);
              }
            }}
            onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
              setName(ev.target.value);
              if (oldName === ev.target.value) {
                setNameError('');
                return;
              }
              if (isBlank(ev.target.value)) {
                setNameError(t('Common.Required'));
              } else if (isProviderDuplicated(ev.target.value)) {
                setNameError(t('Provider.Tooltip.NameOfProviderMustBeUnique'));
              } else {
                setNameError('');
              }
            }}
          />
        </Field>
        <Field
          label={t('Common.Currency')}
          className="flex-shrink-0 min-w-[90px]"
          size="small"
        >
          <Select
            value={currency}
            onChange={(ev) => {
              setCurrency(ev.target.value);
              updateProvider(name, {
                currency: ev.target.value as 'USD' | 'CNY',
              });
            }}
          >
            <option>USD</option>
            <option>CNY</option>
          </Select>
        </Field>
        <Field size="small" className="-mb-2 ml-1">
          <Label className="w-[50px] -mb-0.5" size="small">
            {t('Common.Default')}
          </Label>
          <Switch
            checked={isDefault}
            className="-ml-1"
            onChange={(ev) => {
              const isChecked = ev.target.checked;
              setIsDefault(isChecked);
              updateProvider(name, {
                isDefault: isChecked,
              });
            }}
          />
        </Field>
      </div>
      <div className="mt-2 flex justify-start items-baseline gap-1">
        <Label className="w-[70px]" size="small">
          {t('Common.APIEndpoint')}
        </Label>
        <Field
          size="small"
          className="field-small flex-grow"
          validationState={endpointError ? 'error' : 'none'}
          validationMessage={endpointError}
        >
          <Input
            size="small"
            value={endpoint}
            className="flex-grow"
            onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
              if (isValidHttpHRL(ev.target.value)) {
                updateProvider(name, {
                  apiBase: ev.target.value,
                });
              } else {
                setEndpointError(t('Provider.Tooltip.InvalidAPIEndpoint'));
              }
            }}
            onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
              setEndpoint(ev.target.value);
              if (isValidHttpHRL(ev.target.value)) {
                setEndpointError('');
              } else {
                setEndpointError(t('Provider.Tooltip.InvalidAPIEndpoint'));
              }
            }}
            placeholder={provider.apiBase || ''}
          />
        </Field>
      </div>
      {getChatAPISchema(provider.name || '').includes('key') && (
        <div className="mt-2 flex justify-start items-baseline gap-1">
          <InfoLabel
            className="w-[70px] flex"
            size="small"
            info={
              provider.referral ? (
                <button
                  type="button"
                  onClick={() =>
                    window.electron.openExternal(provider.referral as string)
                  }
                >
                  {t('Common.GetAPIKey')}
                </button>
              ) : (
                ''
              )
            }
          >
            {t('Common.APIKey')}
          </InfoLabel>
          <Field size="small" className="field-small flex-grow">
            <MaskableInput
              className="flex-grow"
              value={apiKey}
              placeholder={t('Common.Placeholder.APIKey')}
              onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
                updateProvider(name, {
                  apiKey: ev.target.value,
                });
              }}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
                setApiKey(ev.target.value);
              }}
            />
          </Field>
        </div>
      )}
      {getChatAPISchema(provider.name || '').includes('proxy') && (
        <div className="mt-2 flex justify-start items-baseline gap-1">
          <Label className="w-[70px]" size="small">
            {t('Common.Proxy')}
          </Label>
          <Field
            size="small"
            className="field-small flex-grow"
            validationState={proxyError ? 'error' : 'none'}
            validationMessage={proxyError}
          >
            <Input
              size="small"
              value={proxy}
              className="flex-grow"
              placeholder={t('Common.Placeholder.Proxy')}
              onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
                if (
                  isBlank(ev.target.value) ||
                  isValidHttpHRL(ev.target.value)
                ) {
                  updateProvider(name, {
                    proxy: ev.target.value,
                  });
                } else {
                  setProxyError(t('Provider.Tooltip.InvalidProxyURL'));
                }
              }}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
                setProxy(ev.target.value);
                if (
                  isBlank(ev.target.value) ||
                  isValidHttpHRL(ev.target.value)
                ) {
                  setProxyError('');
                } else {
                  setProxyError(t('Provider.Tooltip.InvalidProxyURL'));
                }
              }}
            />
          </Field>
        </div>
      )}
      {getChatAPISchema(provider.name || '').includes('secret') && (
        <div className="mt-2 flex justify-start items-baseline gap-1">
          <Label className="w-[70px]" size="small">
            {t('Common.SecretKey')}
          </Label>
          <Field
            size="small"
            className="field-small flex-grow"
            validationState={secretError ? 'error' : 'none'}
            validationMessage={secretError}
          >
            <MaskableInput
              value={secret}
              onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
                if (isBlank(ev.target.value)) {
                  setSecretError(t('Common.Required'));
                } else {
                  setSecretError('');
                  updateProvider(name, {
                    apiSecret: ev.target.value,
                  });
                }
              }}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
                setSecret(ev.target.value);
                if (isBlank(ev.target.value)) {
                  setSecretError(t('Common.Required'));
                } else {
                  setSecretError('');
                }
              }}
            />
          </Field>
        </div>
      )}
      {getChatAPISchema(provider.name || '').includes('version') && (
        <div className="mt-2 flex justify-start items-baseline gap-1">
          <Label className="w-[70px]" size="small">
            {t('Common.APIVersion')}
          </Label>
          <Field
            size="small"
            className="field-small flex-grow"
            validationState={versionError ? 'error' : 'none'}
            validationMessage={versionError}
          >
            <Input
              value={version}
              onBlur={(ev: React.FocusEvent<HTMLInputElement>) => {
                if (isBlank(ev.target.value)) {
                  setVersionError(t('Common.Required'));
                } else {
                  setVersionError('');
                  updateProvider(name, {
                    apiVersion: ev.target.value,
                  });
                }
              }}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
                setVersion(ev.target.value);
                if (isBlank(ev.target.value)) {
                  setVersionError(t('Common.Required'));
                } else {
                  setVersionError('');
                }
              }}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
