import { useTranslation } from 'react-i18next';
import Empty from '../components/Empty';

export default function NotFound() {
  const { t } = useTranslation();
  return <Empty image="construction" text={t('Apps.Error.NotFound')} />;
}
