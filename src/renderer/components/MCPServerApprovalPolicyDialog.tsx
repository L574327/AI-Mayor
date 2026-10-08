import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Button,
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
} from '@fluentui/react-components';
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createRoot } from 'react-dom/client';
import useMarkdown from 'hooks/useMarkdown';

export type MCPServerApprovalPolicyDialogProps = {
  toolName: string;
  toolType: 'local' | 'remote';
  methodName: string;
  parameters: unknown;
  onConfirm: () => void;
  onCancel: () => void;
};

export type MCPServerApprovalPolicyDialogOpenOptions = Omit<
  MCPServerApprovalPolicyDialogProps,
  'onConfirm' | 'onCancel'
>;

const MCPServerApprovalPolicyDialog = function MCPServerApprovalPolicyDialog(
  props: MCPServerApprovalPolicyDialogProps,
) {
  const [open, setOpen] = useState(true);

  const { t } = useTranslation();
  const { render } = useMarkdown();
  const { onCancel, onConfirm } = props;
  const { toolName, toolType, methodName, parameters } = props;

  const handleCancel = useCallback(() => {
    setOpen(false);
    onCancel();
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    onConfirm();
  }, [onConfirm]);

  return (
    <Dialog open={open}>
      <DialogSurface
        mountNode={document.body.querySelector('#portal')}
        className="w-[568px]"
      >
        <DialogBody>
          <DialogTitle>
            {t('Tools.ApprovalMessage', {
              tool: toolName,
              type:
                toolType === 'local' ? t('Common.Local') : t('Common.Remote'),
            })}
          </DialogTitle>
          <DialogContent>
            <div className="mb-2">
              <div className="mb-2">
                <code>{methodName}</code>
              </div>
              <div
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{
                  __html: render(
                    `\`\`\`json\n${JSON.stringify(parameters, null, 2)}\n\`\`\``,
                  ),
                }}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={handleCancel}>
              {t('Common.Deny')}
            </Button>
            <Button appearance="primary" onClick={handleConfirm}>
              {t('Common.Allow')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

MCPServerApprovalPolicyDialog.open = (
  options: MCPServerApprovalPolicyDialogOpenOptions,
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const root = createRoot(container);

    const unmount = () => {
      root.unmount();
      container.parentNode?.removeChild(container);
    };

    root.render(
      <MCPServerApprovalPolicyDialog
        onConfirm={() => {
          resolve();
          unmount();
        }}
        onCancel={() => {
          reject(new Error('Canceled'));
          unmount();
        }}
        toolName={options.toolName}
        toolType={options.toolType}
        methodName={options.methodName}
        parameters={options.parameters}
      />,
    );
  });
};

export default MCPServerApprovalPolicyDialog;
