import {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import Mousetrap from 'mousetrap';
import {
  QuestionCircle20Regular,
  ArrowRight16Regular,
  ArrowLeft16Regular,
  Alert20Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useAppearanceStore from 'stores/useAppearanceStore';
import usePlatform from 'hooks/usePlatform';

export default function Footer({ collapsed }: { collapsed: boolean }) {
  const toggleSidebarCollapsed = useAppearanceStore(
    (state) => state.toggleSidebarCollapsed,
  );
  const { isDarwin } = usePlatform();
  const { t } = useTranslation();
  useEffect(() => {
    Mousetrap.bind('mod+t', () => toggleSidebarCollapsed());
    return () => {
      Mousetrap.unbind('mod+t');
    };
  }, []);

  return (
    <div
      className={`${isDarwin ? 'darwin' : ''} flex w-full items-center justify-between self-baseline border-t border-base bg-brand-sidebar px-6 py-2 ${
        collapsed ? 'flex-col' : ''
      }`}
    >

      <button
        type="button"
        title="Mod+t"
        className={`hidden items-center gap-3 rounded-md px-2 py-2 text-xs font-medium outline-none hover:bg-brand-surface-1 hover:text-brand-base md:flex ${
          collapsed ? 'w-full justify-center' : ''
        }`}
        onClick={() => toggleSidebarCollapsed()}
      >
        {collapsed ? <ArrowRight16Regular /> : <ArrowLeft16Regular />}
      </button>
      <div className="relative" />
    </div>
  );
}
