/* eslint-disable react/no-danger */
import {
  DataGridBody,
  DataGrid,
  DataGridRow,
  DataGridHeader,
  DataGridCell,
  DataGridHeaderCell,
  RowRenderer,
} from '@fluentui-contrib/react-data-grid-react-window';
import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  TableCell,
  TableCellActions,
  TableCellLayout,
  TableColumnDefinition,
  createTableColumn,
  useFluent,
  useScrollbarWidth,
} from '@fluentui/react-components';
import {
  bundleIcon,
  PinFilled,
  PinRegular,
  PinOffFilled,
  PinOffRegular,
  DeleteFilled,
  DeleteRegular,
  EditFilled,
  EditRegular,
  MoreHorizontalFilled,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import ConfirmDialog from 'renderer/components/ConfirmDialog';
import useNav from 'hooks/useNav';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDateTime, unix2date, highlight, date2unix } from 'utils/util';
import usePromptStore from 'stores/usePromptStore';
import useToast from 'hooks/useToast';
import useUI from 'hooks/useUI';
import { IPromptDef } from '../../../intellichat/types';

/**
 * Bundled icon for edit actions
 */
const EditIcon = bundleIcon(EditFilled, EditRegular);

/**
 * Bundled icon for delete actions
 */
const DeleteIcon = bundleIcon(DeleteFilled, DeleteRegular);

/**
 * Bundled icon for pin actions
 */
const PinIcon = bundleIcon(PinFilled, PinRegular);

/**
 * Bundled icon for unpin actions
 */
const PinOffIcon = bundleIcon(PinOffFilled, PinOffRegular);

/**
 * Bundled icon for more horizontal menu actions
 */
const MoreHorizontalIcon = bundleIcon(
  MoreHorizontalFilled,
  MoreHorizontalRegular,
);

/**
 * Grid component that displays a list of prompts in a data grid format with actions
 * @param {Object} props - Component props
 * @param {IPromptDef[]} props.prompts - Array of prompt definitions to display
 * @param {string} props.keyword - Search keyword for highlighting text (defaults to empty string)
 * @returns {JSX.Element} The rendered grid component
 */
export default function Grid({
  prompts,
  keyword = '',
}: {
  prompts: IPromptDef[];
  keyword: string;
}) {
  const { t } = useTranslation();
  const { calcHeight } = useUI();
  const [delConfirmDialogOpen, setDelConfirmDialogOpen] =
    useState<boolean>(false);
  const [innerHeight, setInnerHeight] = useState(window.innerHeight);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const deletePrompt = usePromptStore((state) => state.deletePrompt);
  const updatePrompt = usePromptStore((state) => state.updatePrompt);
  const { notifySuccess } = useToast();
  const navigate = useNav();
  
  /**
   * Pins a prompt by setting its pinedAt timestamp
   * @param {string} id - The ID of the prompt to pin
   */
  const pinPrompt = (id: string) => {
    updatePrompt({ id, pinedAt: date2unix(new Date()) });
  };
  
  /**
   * Unpins a prompt by clearing its pinedAt timestamp
   * @param {string} id - The ID of the prompt to unpin
   */
  const unpinPrompt = (id: string) => {
    updatePrompt({ id, pinedAt: null });
  };

  useEffect(() => {
    /**
     * Handles window resize events by updating the inner height state
     */
    const handleResize = () => {
      setInnerHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const items = useMemo(
    () =>
      prompts.map((prompt) => {
        const models = prompt.models || [];
        return {
          id: prompt.id,
          name: { value: prompt.name },
          models: {
            value:
              models.length > 2
                ? models.slice(0, 2).concat(`and ${models.length - 2} more...`)
                : models,
          },
          updatedAt: {
            value: fmtDateTime(unix2date(prompt.updatedAt as number)),
            timestamp: prompt.updatedAt,
          },
          pined: !!prompt.pinedAt,
        };
      }),
    [prompts],
  );

  /**
   * Type definition for name cell data
   */
  type NameCell = {
    value: string;
  };
  
  /**
   * Type definition for models cell data
   */
  type ModelsCell = {
    value: string[];
  };
  
  /**
   * Type definition for updated date cell data
   */
  type UpdatedCell = {
    value: string;
    timestamp: number;
  };
  
  /**
   * Type definition for grid item data
   */
  type Item = {
    id: string;
    name: NameCell;
    models: ModelsCell;
    updatedAt: UpdatedCell;
    pined: boolean;
  };

  /**
   * Column definitions for the data grid including name, models, and updatedAt columns
   */
  const columns: TableColumnDefinition<Item>[] = [
    createTableColumn<Item>({
      columnId: 'name',
      compare: (a: Item, b: Item) => {
        return a.name.value.localeCompare(b.name.value);
      },
      renderHeaderCell: () => {
        return t('Common.Name');
      },
      renderCell: (item) => {
        return (
          <TableCell>
            <TableCellLayout truncate>
              <div className="flex flex-start items-center">
                <div
                  dangerouslySetInnerHTML={{
                    __html: highlight(item.name.value, keyword),
                  }}
                />
                {item.pined ? <PinFilled className="ml-1" /> : null}
              </div>
            </TableCellLayout>
            <TableCellActions>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button icon={<MoreHorizontalIcon />} appearance="subtle" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem
                      icon={<EditIcon />}
                      onClick={() => navigate(`/prompts/form/${item.id}`)}
                    >
                      {t('Common.Edit')}
                    </MenuItem>
                    <MenuItem
                      icon={<DeleteIcon />}
                      onClick={() => {
                        setActivePromptId(item.id);
                        setDelConfirmDialogOpen(true);
                      }}
                    >
                      {t('Common.Delete')}{' '}
                    </MenuItem>
                    {item.pined ? (
                      <MenuItem
                        icon={<PinOffIcon />}
                        onClick={() => unpinPrompt(item.id)}
                      >
                        {t('Common.Unpin')}{' '}
                      </MenuItem>
                    ) : (
                      <MenuItem
                        icon={<PinIcon />}
                        onClick={() => pinPrompt(item.id)}
                      >
                        {t('Common.Pin')}{' '}
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </TableCellActions>
          </TableCell>
        );
      },
    }),
    createTableColumn<Item>({
      columnId: 'models',
      compare: (a, b) => {
        return a.models.value.join(',').localeCompare(b.models.value.join(','));
      },
      renderHeaderCell: () => {
        return t('Prompt.Form.ApplicableModels');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout truncate>
            <span className="latin">{item.models.value.join(', ')}</span>
          </TableCellLayout>
        );
      },
    }),
    createTableColumn<Item>({
      columnId: 'updatedAt',
      compare: (a, b) => {
        return a.updatedAt.value.localeCompare(b.updatedAt.value);
      },
      renderHeaderCell: () => {
        return t('Common.LastUpdated');
      },
      renderCell: (item) => {
        return (
          <TableCellLayout>
            <span className="latin">{item.updatedAt.value}</span>
          </TableCellLayout>
        );
      },
    }),
  ];

  /**
   * Custom row renderer for the data grid
   * @param {Object} props - Row renderer props
   * @param {Item} props.item - The item data for the row
   * @param {string} props.rowId - The unique ID for the row
   * @param {React.CSSProperties} style - Inline styles for the row
   * @returns {JSX.Element} The rendered row component
   */
  const renderRow: RowRenderer<Item> = ({ item, rowId }, style) => (
    <DataGridRow<Item> key={rowId} style={style}>
      {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
    </DataGridRow>
  );
  const { targetDocument } = useFluent();
  const scrollbarWidth = useScrollbarWidth({ targetDocument });

  return (
    <div className="w-full">
      <DataGrid
        items={items}
        columns={columns}
        focusMode="cell"
        sortable
        size="small"
        className="w-full"
        getRowId={(item) => item.id}
      >
        <DataGridHeader style={{ paddingRight: scrollbarWidth }}>
          <DataGridRow>
            {({ renderHeaderCell }) => (
              <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
            )}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<Item>
          itemSize={50}
          height={calcHeight(innerHeight - 155)}
        >
          {renderRow}
        </DataGridBody>
      </DataGrid>
      <ConfirmDialog
        open={delConfirmDialogOpen}
        setOpen={setDelConfirmDialogOpen}
        onConfirm={() => {
          deletePrompt(activePromptId as string);
          setActivePromptId(null);
          notifySuccess(t('Prompt.Notification.Deleted'));
        }}
      />
    </div>
  );
}
