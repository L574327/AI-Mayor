import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  DialogBody,
  Button,
} from '@fluentui/react-components';
import Mousetrap from 'mousetrap';
import { useTranslation } from 'react-i18next';
import React, { useCallback, useEffect } from 'react';

export default function ConfirmDialog(args: {
  open: boolean;
  setOpen: (open: boolean) => void;
  onConfirm: () => void;
  onCancel?: () => void;
  title?: string;
  message?: string;
}) {
  const { open, setOpen, onConfirm, onCancel, title, message } = args;
  const confirmButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const { t } = useTranslation();
  const confirm = useCallback(() => {
    async function confirmAndClose() {
      await onConfirm();
      setOpen(false);
    }
    confirmAndClose();
  }, [setOpen, onConfirm]);

  useEffect(() => {
    if (open) {
      setTimeout(() => confirmButtonRef.current?.focus(), 200);
      Mousetrap.bind('esc', () => setOpen(false));
    }
    return () => {
      Mousetrap.unbind('esc');
    };
  }, [open]);

  return (
    <Dialog open={open}>
      <DialogSurface className="w-[468px]">
        <DialogBody>
          <DialogTitle>{title || t('Common.DeleteConfirmation')}</DialogTitle>
          <DialogContent>
            <div className="mt-1 mb-4">
              {message || t('Common.DeleteConfirmationInfo')}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                onClick={() => {
                  setOpen(false);
                  onCancel?.();
                }}
              >
                {t('Common.Cancel')}
              </Button>
            </DialogTrigger>
            <DialogTrigger disableButtonEnhancement>
              <Button
                appearance="primary"
                onClick={() => confirm()}
                ref={confirmButtonRef}
              >
                {t('Common.Delete')}
              </Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
