import { Input, Button, InputOnChangeData } from '@fluentui/react-components';
import { Search24Regular } from '@fluentui/react-icons';
import useNav from 'hooks/useNav';
import { ChangeEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Empty from 'renderer/components/Empty';
import usePromptStore from 'stores/usePromptStore';
import Grid from './Grid';

export default function Prompts() {
  const { t } = useTranslation();
  const navigate = useNav();
  const prompts = usePromptStore((state) => state.prompts);
  const fetchPrompts = usePromptStore((state) => state.fetchPrompts);
  const [keyword, setKeyword] = useState<string>('');
  useEffect(() => {
    fetchPrompts({ keyword });
  }, [keyword, fetchPrompts]);

  const onKeywordChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setKeyword(data.value || '');
  };
  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.Prompts')}</h1>
          <div className="flex justify-end w-full items-center gap-2">
            <Button
              appearance="primary"
              onClick={() => navigate('/prompts/form')}
            >
              {t('Common.New')}
            </Button>
            <Input
              contentBefore={<Search24Regular />}
              placeholder={t('Common.Search')}
              value={keyword}
              onChange={onKeywordChange}
              style={{ maxWidth: 288 }}
              className="flex-grow flex-shrink"
            />
          </div>
        </div>
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        {prompts.length ? (
          <div className="mr-5 flex justify-start gap-2 flex-wrap">
            <Grid prompts={prompts} keyword={keyword} />
          </div>
        ) : (
          <Empty image="design" text={t('Prompt.Info.Empty')} />
        )}
      </div>
    </div>
  );
}
