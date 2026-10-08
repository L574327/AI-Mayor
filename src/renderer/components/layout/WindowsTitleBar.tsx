import './WindowsTitleBar.scss';
import {
  Popover,
  PopoverTrigger,
  Button,
  PopoverSurface,
} from '@fluentui/react-components';
import useOnlineStatus from 'hooks/useOnlineStatus';
import Mousetrap from 'mousetrap';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bundleIcon,
  PanelLeftText24Filled,
  PanelLeftText24Regular,
  Search24Filled,
  Search24Regular,
  Wifi124Filled,
  Wifi124Regular,
  WifiOff24Filled,
  WifiOff24Regular,
} from '@fluentui/react-icons';
import SearchDialog from 'renderer/components/SearchDialog';
import UpgradeIndicator from 'renderer/components/UpgradeIndicator';
import useAppearanceStore from 'stores/useAppearanceStore';
// @ts-ignore
import logoImage from '../../../assets/images/logo.png';

const PanelLeftIcon = bundleIcon(PanelLeftText24Filled, PanelLeftText24Regular);
const SearchIcon = bundleIcon(Search24Filled, Search24Regular);
const OnlineIcon = bundleIcon(Wifi124Filled, Wifi124Regular);
const OfflineIcon = bundleIcon(WifiOff24Filled, WifiOff24Regular);

function WindowsTitleBar() {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const toggleSidebarVisibility = useAppearanceStore(
    (state) => state.toggleSidebarVisibility,
  );
  const NetworkStatusIcon = useOnlineStatus() ? (
    <Popover withArrow size="small" closeOnScroll>
      <PopoverTrigger disableButtonEnhancement>
        <Button icon={<OnlineIcon />} appearance="transparent" />
      </PopoverTrigger>
      <PopoverSurface>
        <div> {t('Common.Online')}</div>
      </PopoverSurface>
    </Popover>
  ) : (
    <Popover withArrow size="small" closeOnScroll>
      <PopoverTrigger disableButtonEnhancement>
        <Button icon={<OfflineIcon />} appearance="transparent" />
      </PopoverTrigger>
      <PopoverSurface>
        <div> {t('Common.Offline')}</div>
      </PopoverSurface>
    </Popover>
  );

  useEffect(() => {
    Mousetrap.bind('mod+f', () => setSearchOpen(true));
    return () => {
      Mousetrap.unbind('mod+f');
    };
  }, []);
  return (
    <div className="custom-titlebar relative">
      <img src={logoImage} alt="logo" className="size-5" />
      <div className="block md:hidden pl-1">
        <Button
          icon={<PanelLeftIcon />}
          appearance="transparent"
          onClick={() => toggleSidebarVisibility()}
        />
      </div>
      <div className="pl-1">
        <Button
          icon={<SearchIcon />}
          appearance="transparent"
          onClick={() => setSearchOpen(true)}
        />
      </div>
      <div>{NetworkStatusIcon}</div>
      <div className="ml-2">
        <UpgradeIndicator />
      </div>
      <SearchDialog open={searchOpen} setOpen={setSearchOpen} />
    </div>
  );
}

export default WindowsTitleBar;
