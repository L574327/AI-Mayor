import { Field, InputOnChangeData } from '@fluentui/react-components';
import { Password20Regular } from '@fluentui/react-icons';
import useToast from 'hooks/useToast';
import { ChangeEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MaskableStateInput from 'renderer/components/MaskableStateInput';
import StateButton from 'renderer/components/StateButton';
import { isValidPassword } from 'utils/validators';
import supabase from 'vendors/supa';

export default function TabPassword() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState('');
  const [isPasswordValid, setIsPasswordValid] = useState(true);

  const { notifyError, notifySuccess } = useToast();

  const updatePassword = async () => {
    if (!isValidPassword(password)) return;
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      notifyError(error.message);
    } else {
      notifySuccess(t('Account.Notification.PasswordChanged'));
      setIsPasswordValid(true);
      setPassword('');
    }
    setLoading(false);
  };
  return (
    <div className="flex flex-col gap-5 w-full min-h-96">
      <div className="text-xl border-b border-base pb-2">
        {t('Common.ChangePassword')}
      </div>
      <Field label={t('Common.NewPassword')}>
        <MaskableStateInput
          className="max-w-md"
          onBlur={() => {
            setIsPasswordValid(isValidPassword(password));
          }}
          isValid={isPasswordValid}
          icon={<Password20Regular />}
          errorMsg={t('Account.Info.PasswordRule')}
          value={password}
          onChange={(
            _ev: ChangeEvent<HTMLInputElement>,
            data: InputOnChangeData,
          ) => {
            setPassword(data.value);
            setIsPasswordValid(true);
          }}
        />
      </Field>
      <div className="tips text-sm">{t('Account.Info.PasswordRule')}</div>
      <div>
        <StateButton
          appearance="primary"
          loading={loading}
          onClick={updatePassword}
        >
          {t('Common.Save')}
        </StateButton>
      </div>
    </div>
  );
}
