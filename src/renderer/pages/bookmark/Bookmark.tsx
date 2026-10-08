/* eslint-disable react/no-danger */
import {
  Button,
  Divider,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
} from '@fluentui/react-components';
import {
  bundleIcon,
  ArrowLeft16Filled,
  ArrowLeft16Regular,
  Delete16Filled,
  Delete16Regular,
  Heart16Regular,
  Heart16Filled,
  HeartOff16Regular,
  HeartOff16Filled,
  ChevronDown16Regular,
  ChevronUp16Regular,
} from '@fluentui/react-icons';
import useMarkdown from 'hooks/useMarkdown';
import useToast from 'hooks/useToast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import useBookmarkStore from 'stores/useBookmarkStore';
import useKnowledgeStore from 'stores/useKnowledgeStore';
import { IBookmark } from 'types/bookmark';
import { fmtDateTime, unix2date } from 'utils/util';
import CitationDialog from '../chat/CitationDialog';
import useMermaid from '../../../hooks/useMermaid';
import useECharts from 'hooks/useECharts';

const ArrowLeftIcon = bundleIcon(ArrowLeft16Filled, ArrowLeft16Regular);
const DeleteIcon = bundleIcon(Delete16Filled, Delete16Regular);
const FavoriteIcon = bundleIcon(Heart16Filled, Heart16Regular);
const UnfavoriteIcon = bundleIcon(HeartOff16Filled, HeartOff16Regular);

/**
 * Bookmark component for displaying and managing individual bookmarks.
 * Provides functionality to view bookmark content, toggle favorites, delete bookmarks,
 * and display citations and references.
 * 
 * @returns {JSX.Element} The rendered bookmark page component
 */
export default function Bookmark() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [delPopoverOpen, setDelPopoverOpen] = useState<boolean>(false);
  const navigate = useNavigate();
  const [updated, setUpdated] = useState<boolean>(false);
  const setActiveBookmarkId = useBookmarkStore(
    (state) => state.setActiveBookmarkId,
  );
  const updateBookmarks = useBookmarkStore((state) => state.updateBookmark);
  const deleteBookmark = useBookmarkStore((state) => state.deleteBookmark);
  const loadFavorites = useBookmarkStore((state) => state.loadFavorites);
  const { showCitation } = useKnowledgeStore();
  const { notifyInfo } = useToast();
  const bookmarks = useBookmarkStore((state) => state.bookmarks);
  const bookmark = useMemo(
    () => bookmarks.find((item) => item.id === id) as IBookmark,
    [id],
  );
  const citedFiles = useMemo(
    () => JSON.parse(bookmark?.citedFiles || '[]'),
    [bookmark],
  );
  const { renderMermaid } = useMermaid();
  const { initECharts, disposeECharts } = useECharts({ message: bookmark });

  /**
   * Renders ECharts components within a given DOM element.
   * Searches for elements with the 'echarts-container' class and initializes charts for each.
   * 
   * @param {string} prefix - The prefix to use for chart identification
   * @param {Element} msgDom - The DOM element to search for chart containers
   */
  const renderECharts = useCallback(
    (prefix: string, msgDom: Element) => {
      const charts = msgDom.querySelectorAll('.echarts-container');
      if (charts.length > 0) {
        charts.forEach((chart) => {
          initECharts(prefix, chart.id);
        });
      }
    },
    [initECharts],
  );

  /**
   * Handles citation link clicks within the bookmark content.
   * Prevents default navigation and shows citation content in a dialog.
   * 
   * @param {any} event - The click event from the citation link
   */
  const onCitationClick = async (event: any) => {
    const url = new URL(event.target?.href);
    if (url.pathname === '/citation' || url.protocol.startsWith('file:')) {
      event.preventDefault();
      const chunkId = url.hash.replace('#', '');
      const chunk = JSON.parse(bookmark.citedChunks || '[]').find(
        (chunk: any) => chunk.id === chunkId,
      );
      if (chunk) {
        showCitation(chunk.content);
      } else {
        notifyInfo(t('Knowledge.Notification.CitationNotFound'));
      }
    }
  };

  // @disable-lint react-hooks/exhaustive-deps
  useEffect(() => {
    setUpdated(false);
    setActiveBookmarkId(id as string);
    const msgDom = document.querySelector(`#${id}`);
    if (!msgDom) {
      return;
    }
    const promptNode = msgDom.querySelector('.bookmark-prompt') as Element;
    renderECharts('prompt', promptNode);
    const replyNode = msgDom.querySelector('.bookmark-reply') as Element;
    renderECharts('reply', replyNode);
    renderMermaid();
    const links = document.querySelectorAll('.bookmark-reply a');
    links.forEach((link) => {
      link.addEventListener('click', onCitationClick);
    });
    return () => {
      links.forEach((link) => {
        link.removeEventListener('click', onCitationClick);
      });
      disposeECharts();
    };
  }, [updated, id]);

  const [isThinkShow, setIsThinkShow] = useState(false);
  
  /**
   * Toggles the visibility of the reasoning/thinking section.
   */
  const toggleThink = useCallback(() => {
    setIsThinkShow(!isThinkShow);
  }, [isThinkShow]);

  const { notifySuccess } = useToast();

  /**
   * Handles bookmark deletion.
   * Deletes the bookmark from storage, navigates back, and shows success notification.
   */
  const onDeleteBookmark = async () => {
    await deleteBookmark(bookmark.id);
    navigate(-1);
    notifySuccess(t('Bookmarks.Notification.Removed'));
  };

  /**
   * Adds the current bookmark to favorites.
   * Updates the bookmark's favorite status, refreshes the favorites list, and shows success notification.
   */
  const addToFavorites = async () => {
    await updateBookmarks({ id: bookmark.id, favorite: true });
    setUpdated(true);
    loadFavorites({ limit: 100, offset: 0 });
    notifySuccess(t('Bookmarks.Notification.Added'));
  };

  /**
   * Removes the current bookmark from favorites.
   * Updates the bookmark's favorite status, refreshes the favorites list, and shows success notification.
   */
  const removeFromFavorites = async () => {
    await updateBookmarks({ id: bookmark.id, favorite: false });
    setUpdated(true);
    loadFavorites({ limit: 100, offset: 0 });
    notifySuccess(t('Bookmarks.Notification.RemovedFavarites'));
  };

  const { render } = useMarkdown();

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header">
        <div className="bookmark-topbar p-1 rounded flex justify-between items-center">
          <div className="flex justify-start items-center">
            <Button
              size="small"
              icon={<ArrowLeftIcon />}
              appearance="subtle"
              className="flex-shrink-0 justify-start"
              onClick={() => navigate(-1)}
            >
              {t('Common.Back')}
            </Button>
            {bookmark?.favorite ? (
              <Button
                size="small"
                icon={<UnfavoriteIcon />}
                appearance="subtle"
                onClick={removeFromFavorites}
              >
                {t('Common.Action.RemoveFromFavorites')}
              </Button>
            ) : (
              <Button
                size="small"
                icon={<FavoriteIcon />}
                appearance="subtle"
                onClick={addToFavorites}
              >
                {t('Common.Action.Favor')}
              </Button>
            )}
            <Popover withArrow open={delPopoverOpen}>
              <PopoverTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  icon={<DeleteIcon />}
                  appearance="subtle"
                  onClick={() => setDelPopoverOpen(true)}
                >
                  {t('Common.Delete')}
                </Button>
              </PopoverTrigger>
              <PopoverSurface>
                <div>
                  <div className="p-2 mb-2 text-center">
                    {t('Common.DeleteConfirmation')}
                  </div>
                  <div className="flex justify-evenly gap-5 items-center">
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => setDelPopoverOpen(false)}
                    >
                      {t('Common.Cancel')}
                    </Button>
                    <Button
                      size="small"
                      appearance="primary"
                      onClick={async () => {
                        await onDeleteBookmark();
                        setDelPopoverOpen(false);
                      }}
                    >
                      {t('Common.Yes')}
                    </Button>
                  </div>
                </div>
              </PopoverSurface>
            </Popover>
          </div>
          <div className="flex justify-start items-center gap-5 mr-4">
            <Text size={200}>
              <span className="latin">{bookmark.model}</span>
            </Text>
            <Text size={200}>
              <span className="latin">
                {fmtDateTime(unix2date(bookmark.createdAt))}
              </span>
            </Text>
          </div>
        </div>
      </div>
      <div className="h-full overflow-y-auto -mr-5 bookmark" id={id}>
        <div className="mr-5">
          <div className="mx-auto">
            <div
              className="bg-brand-surface-2 rounded px-1.5 py-2.5 bookmark-prompt"
              dangerouslySetInnerHTML={{
                __html: render(bookmark.prompt || ''),
              }}
            />
            <div className="mt-2.5 -mr-5 bookmark-reply">
              {bookmark.reasoning?.trim() ? (
                <div className="think">
                  <div className="think-header" onClick={toggleThink}>
                    <span className="font-bold text-gray-400 ">
                      {t('Reasoning.Thought')}
                    </span>
                    <div className="text-gray-400 -mb-0.5">
                      {isThinkShow ? (
                        <ChevronUp16Regular />
                      ) : (
                        <ChevronDown16Regular />
                      )}
                    </div>
                  </div>
                  <div
                    className="think-body"
                    style={{ display: isThinkShow ? 'block' : 'none' }}
                  >
                    <div
                      dangerouslySetInnerHTML={{
                        __html: render(bookmark.reasoning || ''),
                      }}
                    />
                  </div>
                </div>
              ) : null}
              <div
                className="mr-5 leading-7"
                dangerouslySetInnerHTML={{
                  __html: render(bookmark.reply || ''),
                }}
              />
            </div>
          </div>
          {citedFiles.length > 0 && (
            <div className="mt-2">
              <div className="mt-4 mb-4">
                <Divider>{t('Common.References')}</Divider>
              </div>
              <ul>
                {citedFiles.map((file: string) => (
                  <li className="text-gray-500" key={file}>
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="h-16" />
      </div>
      <CitationDialog />
    </div>
  );
}
