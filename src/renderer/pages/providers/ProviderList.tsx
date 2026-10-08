import {
  List,
  ListItem,
  MenuTrigger,
  MenuButton,
  MenuPopover,
  MenuList,
  MenuItem,
  Menu,
  Switch,
  Field,
} from '@fluentui/react-components';
import {
  bundleIcon,
  CaretLeft16Regular,
  ChevronRightRegular,
  MoreVerticalFilled,
  MoreVerticalRegular,
} from '@fluentui/react-icons';
import { t } from 'i18next';
import { find } from 'lodash';
import { IChatProviderConfig } from 'providers/types';
import { useEffect, useMemo, useState } from 'react';
import ConfirmDialog from 'renderer/components/ConfirmDialog';
import useProviderStore from 'stores/useProviderStore';

const MoreVerticalIcon = bundleIcon(MoreVerticalFilled, MoreVerticalRegular);

export default function ProviderList({ height = 400 }: { height: number }) {
  const selectedProvider = useProviderStore((state) => state.provider);
  const [targetProvider, setTargetProvider] =
    useState<IChatProviderConfig | null>(null);
  const providers = useProviderStore((state) => state.providers);
  const { setProvider, deleteProvider, updateProvider, getAvailableProviders } =
    useProviderStore();
  const [delConfirmDialogOpen, setDelConfirmDialogOpen] = useState(false);

  const availableProviders = useMemo(
    () => getAvailableProviders({ withDisabled: true }),
    [getAvailableProviders, providers],
  );

  useEffect(() => {
    if (!selectedProvider) {
      setProvider(find(providers, { isDefault: true }) || providers[0]);
    }
  }, [selectedProvider, setProvider, providers]);

  return (
    <div>
      <List
        className="overflow-y-auto"
        style={{
          height,
        }}
      >
        {availableProviders.map((provider: IChatProviderConfig) => {
          return (
            <ListItem
              key={provider.name}
              aria-label={provider.name}
              className="block hover:bg-stone-100 dark:hover:bg-zinc-700/25 group"
            >
              <div
                className={`flex justify-between items-center border-b border-gray-100 dark:border-zinc-800/25 w-full ${selectedProvider?.name === provider.name ? 'bg-stone-100 dark:bg-zinc-700/25' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => setProvider(provider)}
                  className="flex justify-start items-center gap-0.5 flex-grow pl-4 py-2 text-left"
                >
                  <span
                    className={
                      provider.disabled
                        ? 'text-gray-300 dark:text-gray-500'
                        : ''
                    }
                  >
                    {provider.name}
                  </span>
                  {provider.isDefault && (
                    <CaretLeft16Regular className="text-gray-500 -mb-[3px]" />
                  )}
                </button>
                <div className="flex justify-center items-center">
                  {selectedProvider?.name === provider.name && (
                    <ChevronRightRegular />
                  )}
                  <div className="invisible group-hover:visible">
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <MenuButton
                          icon={<MoreVerticalIcon />}
                          appearance="transparent"
                          size="small"
                        />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem disabled>
                            {provider?.name}
                            {provider?.isBuiltIn && (
                              <span className="text-xs ml-2">(build-in)</span>
                            )}
                          </MenuItem>
                          {provider?.isBuiltIn || (
                            <MenuItem
                              onClick={() => {
                                setTargetProvider(provider);
                                setDelConfirmDialogOpen(true);
                              }}
                            >
                              {t('Common.Delete')}
                            </MenuItem>
                          )}
                          <MenuItem style={{ padding: 0 }} persistOnClick>
                            <Field size="small" className="field-small ">
                              <Switch
                                label={t('Common.Enabled')}
                                className="text-xs"
                                checked={!provider.disabled}
                                onChange={() => {
                                  const updatedProvider = {
                                    name: provider.name,
                                    disabled: !provider.disabled,
                                  };
                                  updateProvider(
                                    provider.name,
                                    updatedProvider,
                                  );
                                }}
                              />
                            </Field>
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>
                </div>
              </div>
            </ListItem>
          );
        })}
      </List>
      <ConfirmDialog
        open={delConfirmDialogOpen}
        setOpen={setDelConfirmDialogOpen}
        title={`${t('Common.Delete')} ${targetProvider?.name}`}
        message={t('Providers.DeleteProviderConfirmMessage')}
        onConfirm={() => {
          if (targetProvider) {
            deleteProvider(targetProvider.name);
            setTargetProvider(null);
          }
        }}
      />
    </div>
  );
}
