import { useTranslation } from 'react-i18next';
import { Image } from '@fluentui/react-components';
import useNav from 'hooks/useNav';
import Empty from '../../components/Empty';
import apps from '../../apps';
import { IAppConfig } from '../../apps/types';

export default function Profile() {
  const { t } = useTranslation();
  const navigate = useNav();
  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.Apps')}</h1>
        </div>
      </div>
      <div className="page-description text-color-secondary text-base my-2">
        {t('Apps.Description')}
      </div>
      <div className="pb-12 h-full -mr-5 overflow-y-auto">
        {apps.length > 0 ? (
          <div className="flex justify-start flex-nowrap items-center mt-10 gap-5">
            {apps.map((app: IAppConfig) => (
              <div
                className="border border-base p-4 rounded shadow w-1/2 md:w-1/3 xl:w-1/4 hover:bg-gray-100"
                onClick={() => navigate(`/apps/${app.key}`)}
                key={app.key}
              >
                <div className="flex flex-col items-start justify-center">
                  <div className="app-icon mb-3">
                    <Image src={app.icon} width={60} height={60} />
                  </div>
                  <div className="text-primary-500 text-lg font-medium">
                    {app.name}
                  </div>
                  <div className="text-color-secondary text-xs mt-1">
                    {app.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty image="construction" text={t('Common.WIP')} />
        )}
      </div>
    </div>
  );
}
