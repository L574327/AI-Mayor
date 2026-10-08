import { Button, Tooltip } from '@fluentui/react-components';
import { Bookmark20Filled, Bookmark20Regular } from '@fluentui/react-icons';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useNav from 'hooks/useNav';
import useBookmarkStore from 'stores/useBookmarkStore';
import { IBookmark } from 'types/bookmark';

/**
 * Navigation component that displays bookmark favorites in a sidebar layout.
 * Supports both collapsed and expanded states with tooltips and active bookmark highlighting.
 * 
 * @param {Object} props - Component props
 * @param {boolean} props.collapsed - Whether the navigation should be displayed in collapsed mode
 * @returns {JSX.Element} The bookmark navigation component
 */
export default function BookmarkNav({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const activeBookmarkId = useBookmarkStore((state) => state.activeBookmarkId);
  const favorites = useBookmarkStore((state) => state.favorites);
  const loadFavorites = useBookmarkStore((state) => state.loadFavorites);
  const navigate = useNav();

  useEffect(() => {
    loadFavorites({ limit: 100, offset: 0 });
  }, [loadFavorites]);

  /**
   * Renders a bookmark icon wrapped in a tooltip component.
   * Shows filled icon for active bookmarks and regular icon for inactive ones.
   * 
   * @param {boolean} isActiveBookmark - Whether this bookmark is currently active
   * @param {string} summary - The bookmark summary text to display in tooltip
   * @returns {JSX.Element} Tooltip component containing the appropriate bookmark icon
   */
  const renderIconWithTooltip = (
    isActiveBookmark: boolean,
    summary: string,
  ) => {
    return (
      <Tooltip
        withArrow
        content={summary?.substring(0, 200)}
        relationship="label"
        positioning="above-start"
      >
        {isActiveBookmark ? <Bookmark20Filled /> : <Bookmark20Regular />}
      </Tooltip>
    );
  };

  /**
   * Renders the list of favorite bookmarks or a hint message when no favorites exist.
   * Each bookmark is displayed as a clickable button with appropriate styling for active state.
   * 
   * @returns {JSX.Element[]} Array of bookmark button elements or hint message
   */
  const renderFavorites = () => {
    if (favorites?.length > 0) {
      return favorites.map((bookmark: IBookmark) => {
        return (
          <div
            className={`px-2 ${collapsed ? 'mx-auto' : ''} ${
              !!activeBookmarkId && activeBookmarkId === bookmark.id
                ? 'active'
                : ''
            }`}
            key={bookmark.id}
          >
            <Button
              icon={renderIconWithTooltip(
                !!activeBookmarkId && activeBookmarkId === bookmark.id,
                bookmark.prompt,
              )}
              appearance="subtle"
              className="w-full justify-start"
              onClick={() => navigate(`/bookmarks/${bookmark.id}`)}
            >
              {collapsed ? null : (
                <div className="text-sm truncate ...">{bookmark.prompt}</div>
              )}
            </Button>
          </div>
        );
      });
    }
    return (
      <div className="p-4 text-sm text-gray-400">
        {collapsed ? null : t('Bookmarks.Hint.Favorites')}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-brand-sidebar">
      <div
        className={`flex flex-col pt-2.5 ${collapsed ? 'content-center' : ''}`}
      >
        {renderFavorites()}
      </div>
    </div>
  );
}