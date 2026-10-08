import {
  Avatar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  SelectTabEvent,
  Tab,
  TabList,
  Text,
} from '@fluentui/react-components';
import {
  CheckmarkStarburst16Filled,
  Premium24Regular,
  ShieldKeyhole24Regular,
} from '@fluentui/react-icons';
import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import Empty from 'renderer/components/Empty';
import useAppearanceStore from 'stores/useAppearanceStore';
import useAuthStore from 'stores/useAuthStore';
import TabPassword from './TabPassword';
import TabSubscription from './TabSubscription';

/**
 * Memoized version of TabPassword component to prevent unnecessary re-renders
 */
const MemorizedTabPassword = memo(TabPassword);

/**
 * Memoized version of TabSubscription component to prevent unnecessary re-renders
 */
const MemorizedTabSubscription = memo(TabSubscription);

/**
 * Account page component that displays user account information and management options.
 * Shows user profile details, account status, and provides tabbed interface for
 * subscription and password management. Displays empty state when user is not authenticated.
 * 
 * @returns {JSX.Element} The rendered account page
 */
export default function Account() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const getPalette = useAppearanceStore((state) => state.getPalette);

  const [tab, setTab] = useState('subscription');

  /**
   * Handles tab selection events and updates the active tab state
   * 
   * @param {SelectTabEvent} _ - The tab selection event (unused)
   * @param {any} tabItem - The selected tab item containing the value
   */
  const onTabSelect = (_: SelectTabEvent, tabItem: any) => {
    setTab(tabItem.value);
  };

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.Account')}</h1>
        </div>
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        {user ? (
          <div>
            <div className="flex justify-start flex-nowrap items-center mb-4">
              <Avatar
                aria-label={t('Common.User')}
                name={user.user_metadata.name}
                color="colorful"
                className="mr-2"
                size={56}
              />
              <div>
                <div>
                  <Text truncate size={500}>
                    <b>{user.user_metadata.name}</b>
                  </Text>
                </div>
                <div>
                  <Text truncate>{user.email}</Text>
                  {user.confirmed_at ? (
                    <CheckmarkStarburst16Filled
                      primaryFill={getPalette('success')}
                    />
                  ) : null}
                </div>
              </div>
            </div>
            {user?.confirmed_at ? null : (
              <div className="page-msg mr-5">
                <MessageBar key="warning" intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {t('Account.Notification.InactiveAccountTitle')}
                    </MessageBarTitle>
                    <Text>{t('Account.Notification.InactiveAccountInfo')}</Text>
                  </MessageBarBody>
                </MessageBar>
              </div>
            )}
            <div className="flex justify-start items-start h-5/6 mt-6">
              <div className="flex-shrink-0 h-full">
                <TabList selectedValue={tab} vertical onTabSelect={onTabSelect}>
                  <Tab
                    value="subscription"
                    icon={<Premium24Regular className="tips" />}
                  >
                    {t('Common.Subscription')}
                  </Tab>
                  <Tab
                    value="password"
                    icon={<ShieldKeyhole24Regular className="tips" />}
                  >
                    {t('Common.Password')}
                  </Tab>
                </TabList>
              </div>
              <div className="border-l border-base w-full px-5">
                {tab === 'password' && <MemorizedTabPassword />}
                {tab === 'subscription' && <MemorizedTabSubscription />}
              </div>
            </div>
          </div>
        ) : (
          <Empty image="door" text={t('Notification.SignOutSuccess')} />
        )}
      </div>
    </div>
  );
}