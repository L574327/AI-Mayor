import {
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogBody,
  Button,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function NewButton() {
  const { t } = useTranslation();
  const [configFilePath, setConfigFilePath] = useState<string>('');

  useEffect(() => {
    window.electron.getUserDataPath(['mcp.json']).then((path: string) => {
      setConfigFilePath(path);
    });
  });

  return (
    <Dialog modalType="non-modal">
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary">{t('Common.Add')}</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('Tool.HowToAddTools')}</DialogTitle>
          <DialogContent>
            <p>{t('Tool.HowToAddToolsDescription')}</p>
            <div>
              <div className="font-bold my-2">{t('Tool.ConfigFile')}</div>
              <code className="underline">{configFilePath}</code>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
