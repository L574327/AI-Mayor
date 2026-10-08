import {
  Button,
  Field,
  Input,
  InputOnChangeData,
  SelectTabData,
  SelectTabEvent,
  Tab,
  TabList,
  TabValue,
  Tooltip,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled,
  Info16Regular,
  Mail20Regular,
  Password20Regular,
} from '@fluentui/react-icons';
import useNav from 'hooks/useNav';
import useToast from 'hooks/useToast';
import { useState, ChangeEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import MaskableInput from 'renderer/components/MaskableInput';
import StateButton from 'renderer/components/StateButton';
import StateInput from 'renderer/components/StateInput';
import useAppearanceStore from 'stores/useAppearanceStore';
import useAuthStore from 'stores/useAuthStore';
import { isValidEmail } from 'utils/validators';
import supabase from 'vendors/supa';

/**
 * Login component that provides user authentication interface with two methods:
 * email/password sign-in and email OTP (one-time password) sign-in.
 * Automatically redirects authenticated users to the account page.
 * 
 * @returns {JSX.Element} The login page component
 */
export default function Login() {
  const { t } = useTranslation();
  const navigate = useNav();
  const { notifyError } = useToast();
  const [tab, setTab] = useState<TabValue>('emailAndPassword');
  const [loading, setLoading] = useState<boolean>(false);
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [otpSent, setOtpSent] = useState<boolean>(false);
  const [isEmailValid, setIsEmailValid] = useState<boolean>(true);
  const session = useAuthStore((state) => state.session);
  const getPalette = useAppearanceStore((state) => state.getPalette);

  // 如果用户已登录，则自动跳转到主页
  useEffect(() => {
    if (session) {
      navigate('/user/account');
    }
  }, [session]);

  /**
   * Handles password input changes and updates the password state.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - The change event from the input element
   * @param {InputOnChangeData} data - The input change data containing the new value
   */
  const onPasswordChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setPassword(data.value);
  };

  /**
   * Handles email input changes, updates the email state, and resets email validation status.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - The change event from the input element
   * @param {InputOnChangeData} data - The input change data containing the new value
   */
  const onEmailChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setEmail(data.value);
    setIsEmailValid(true);
  };

  /**
   * Handles tab selection changes between email/password and email OTP authentication methods.
   * 
   * @param {SelectTabEvent} event - The tab selection event
   * @param {SelectTabData} data - The tab selection data containing the selected tab value
   */
  const onTabSelect = (event: SelectTabEvent, data: SelectTabData) => {
    setTab(data.value);
  };

  /**
   * Sends a one-time password to the user's email address for authentication.
   * Validates the email before sending and handles loading states and error notifications.
   * 
   * @async
   * @returns {Promise<void>}
   */
  const sendOneTimePassword = async () => {
    if (!isValidEmail(email)) return;
    setLoading(true);
    const protocol = await window.electron.getProtocol();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${protocol}://login-callback`,
      },
    });
    if (error) {
      notifyError(error.message);
    } else {
      setOtpSent(true);
    }
    setLoading(false);
  };

  /**
   * Authenticates the user using email and password credentials.
   * Validates the email before attempting sign-in and handles loading states and error notifications.
   * 
   * @async
   * @returns {Promise<void>}
   */
  const signInWithEmailAndPassword = async () => {
    if (!isValidEmail(email)) return;
    setLoading(true);
    const { error } = await useAuthStore
      .getState()
      .signInWithEmailAndPassword(email, password);
    if (error) {
      notifyError(error.message);
    }
    setLoading(false);
  };

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">{t('Common.SignIn')}</h1>
        </div>
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        <TabList selectedValue={tab} onTabSelect={onTabSelect}>
          <Tab value="emailAndPassword">
            {t('Auth.Tab.SignInWithPasswordAndEmail')}
          </Tab>
          <Tab value="emailOTP">{t('Auth.Tab.SignInWithEmailOTP')}</Tab>
        </TabList>
        <div
          style={{ maxWidth: '400px' }}
          className="flex flex-col gap-5 ml-3 mt-4"
        >
          <div>
            <Field label={t('Common.Email')}>
              <StateInput
                isValid={isEmailValid}
                onBlur={() => {
                  setIsEmailValid(isValidEmail(email));
                }}
                value={email}
                onChange={onEmailChange}
                icon={<Mail20Regular />}
                errorMsg={t('Auth.Notification.InvalidEmailWarning')}
                contentAfter={
                  tab === 'emailAndPassword' ? null : otpSent ? (
                    <CheckmarkCircle20Filled
                      primaryFill={getPalette('success')}
                    />
                  ) : (
                    <StateButton
                      size="small"
                      appearance="primary"
                      loading={loading}
                      onClick={sendOneTimePassword}
                    >
                      {t('Auth.Action.sendOTPEmail')}
                    </StateButton>
                  )
                }
              />
              {tab === 'emailOTP' ? (
                otpSent ? (
                  <div className="tips flex items-center mt-2">
                    <b className="text-color-success">
                      {t('Auth.Notification.OTPSentTitle')}
                      {t('Auth.Notification.OTPSentInfo')}
                    </b>
                  </div>
                ) : (
                  <div className="tips flex items-center mt-2">
                    <Info16Regular />
                    &nbsp;{t('Auth.Info.SignInWithEmailOTP')}
                  </div>
                )
              ) : null}
            </Field>
          </div>
          <div>
            {tab === 'emailAndPassword' ? (
              <Field label={t('Common.Password')}>
                <MaskableInput
                  onChange={onPasswordChange}
                  value={password}
                  contentBefore={<Password20Regular />}
                />
              </Field>
            ) : null}
          </div>
          {tab === 'emailAndPassword' ? (
            <div className="flex items-start gap-2">
              <StateButton
                loading={loading}
                appearance="primary"
                onClick={signInWithEmailAndPassword}
              >
                {t('Common.SignIn')}
              </StateButton>
              <Tooltip
                content={t('Account.Info.ResetPassword')}
                relationship="label"
              >
                <Button appearance="subtle">
                  {t('Account.ForgotPassword')}
                </Button>
              </Tooltip>
            </div>
          ) : null}
          <div>
            <Link to="/user/register" className="underline">
              {t('Account.NoAccountAndSignUp')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
