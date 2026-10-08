/* eslint-disable react/no-danger */
import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { Input, InputOnChangeData } from '@fluentui/react-components';
import { Search24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { debounce } from 'lodash';
import useBookmarkStore from 'stores/useBookmarkStore';
import { IBookmark } from 'types/bookmark';
import useNav from 'hooks/useNav';
import Empty from 'renderer/components/Empty';
import { getRelativeTime, highlight } from '../../../utils/util';

import './Bookmark.scss';

export default function Bookmarks() {
  const { t } = useTranslation();
  const navigate = useNav();
  const [keyword, setKeyword] = useState<string>('');
  const bookmarks = useBookmarkStore((state) => state.bookmarks);
  const loadBookmarks = useBookmarkStore((state) => state.loadBookmarks);

  const onKeywordChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setKeyword(data.value || '');
  };

  const debouncedLoadBookmarks = useMemo(
    () =>
      debounce(
        async (filter: string) => {
          await loadBookmarks({ limit: 1000, keyword: filter });
        },
        400,
        {
          leading: true,
          maxWait: 2000,
        },
      ),
    [loadBookmarks],
  );

  useEffect(() => {
    debouncedLoadBookmarks(keyword);
  }, [debouncedLoadBookmarks, keyword]);

  const navToDetail = (id: string) => {
    navigate(`/bookmarks/${id}`);
  };

  const bookmarkItem = (bookmark: IBookmark) => {
    return (
      <div
        key={bookmark.id}
        role="presentation"
        className="bookmark-item flex-grow pb-12 bg-brand-surface-2 w-full rounded relative"
        onClick={() => navToDetail(bookmark.id)}
      >
        <div className="px-2.5 pt-2.5 text-ellipsis text-wrap break-word">
          <strong
            dangerouslySetInnerHTML={{
              __html: highlight(bookmark.prompt?.substring(0, 70) +
              (bookmark.prompt.length > 70 ? '...' : ''), keyword),
            }}
          />
        </div>
        <div className="px-2.5 pt-1.5 text-ellipsis leading-6">
          <div
            className='text-xs leading-5'
            dangerouslySetInnerHTML={{
              __html: highlight(
                bookmark.reply?.substring(0, 160) +
                  (bookmark.reply.length > 160 ? '...' : ''),
                keyword,
              ),
            }}
          />
        </div>
        <div className="absolute flex justify-between items-center gap-5 bottom-0 left-0 right-0 px-2.5 py-2.5 latin  text-xs">
          <div className="tag-model text-nowrap overflow-hidden text-ellipsis">{bookmark.model}</div>
          <div className="tag-time  text-xs text-nowrap overflow-hidden text-ellipsis text-gray-400">
            {getRelativeTime(new Date(bookmark.createdAt*1000))}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between w-full">
        <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.Bookmarks')}</h1>
        <Input
          contentBefore={<Search24Regular />}
          placeholder={t('Common.Search')}
          value={keyword}
          onChange={onKeywordChange}
          className="w-72"
        />
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        {bookmarks.length ? (
          <div className=" bookmarks gap-5 mr-5 grid md:grid-cols-2 grid-cols-1 mb-10">
            {bookmarks.map((bookmark) => bookmarkItem(bookmark))}
          </div>
        ) : (
          <Empty image="reading" text={t('No bookmarks yet')} />
        )}
      </div>
    </div>
  );
}
