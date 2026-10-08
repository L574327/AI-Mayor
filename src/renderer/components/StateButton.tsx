import { Button, Spinner } from '@fluentui/react-components';
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';

function StateButton(
  { loading, icon, children, ...rest }: { loading: boolean } & any,
  ref: any,
) {
  const { t } = useTranslation();
  return (
    <Button
      {...rest}
      ref={ref}
      disabled={loading}
      icon={loading ? <Spinner size="extra-tiny" /> : icon}
    >
      {loading ? t('Common.Waiting') : children}
    </Button>
  );
}

export default forwardRef(StateButton);
