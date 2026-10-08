import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  Button,
} from '@fluentui/react-components';
import DOMPurify from 'dompurify';
import {
  CheckmarkCircle24Filled,
  Warning24Filled,
  ErrorCircle24Filled,
  Info24Filled,
} from '@fluentui/react-icons';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useAppearanceStore from 'stores/useAppearanceStore';

export default function AlertDialog(args: {
  type: 'success' | 'warning' | 'error' | 'info';
  open: boolean;
  setOpen: (open: boolean) => void;
  title?: string;
  message: string;
  onConfirm?: () => void;
}) {
  const { t } = useTranslation();
  const { type, open, setOpen, title, message, onConfirm } = args;
  const { getPalette } = useAppearanceStore.getState();
  const renderIcon = useCallback(() => {
    switch (type) {
      case 'success':
        return (
          <CheckmarkCircle24Filled
            className="mr-2"
            primaryFill={getPalette('success')}
          />
        );
      case 'warning':
        return (
          <Warning24Filled
            className="mr-2"
            primaryFill={getPalette('warning')}
          />
        );
      case 'error':
        return (
          <ErrorCircle24Filled
            className="mr-2"
            primaryFill={getPalette('error')}
          />
        );
      case 'info':
        return (
          <Info24Filled className="mr-2" primaryFill={getPalette('info')} />
        );
      default:
        return null;
    }
  }, [type]);

  return (
    <Dialog
      modalType="alert"
      open={open}
      onOpenChange={(event, data) => setOpen(data.open)}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {renderIcon()}
            {title}
          </DialogTitle>
          <DialogContent>
            <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message) }} />
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button
                appearance="primary"
                onClick={() => {
                  setOpen(false);
                  if (onConfirm) onConfirm();
                }}
              >
                {t('Common.OK')}
              </Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
