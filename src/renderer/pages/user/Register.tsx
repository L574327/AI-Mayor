import {
  Field,
  InfoLabel,
  InputOnChangeData,
  useFocusableGroup,
} from '@fluentui/react-components';
import { useState, ChangeEvent, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import supabase from 'vendors/supa';
import {
  isValidEmail,
  isValidPassword,
  isValidUsername,
} from 'utils/validators';
import {
  Mail20Regular,
  Password20Regular,
  PersonInfo20Regular,
} from '@fluentui/react-icons';
import useToast from 'hooks/useToast';
import { Link } from 'react-router-dom';
import AlertDialog from 'renderer/components/AlertDialog';
import useNav from 'hooks/useNav';
import useAuthStore from 'stores/useAuthStore';
import StateButton from 'renderer/components/StateButton';
import StateInput from 'renderer/components/StateInput';
import MaskableStateInput from 'renderer/components/MaskableStateInput';
import { captureException } from 'renderer/logging';

/**
 * Register component that provides a user registration form with validation.
 * Handles user account creation through Supabase authentication with email verification.
 * 
 * @returns {JSX.Element} The registration form component
 */
export default function Register() {
  const { t } = useTranslation();
  const { notifyError } = useToast();
  const navigate = useNav();
  const attributes = useFocusableGroup({ tabBehavior: 'limited' });
  const nameRef = useRef<HTMLInputElement>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [isNameValid, setIsNameValid] = useState<boolean>(true);
  const [email, setEmail] = useState<string>('');
  const [isEmailValid, setIsEmailValid] = useState<boolean>(true);
  const [password, setPassword] = useState<string>('');
  const [isPasswordValid, setIsPasswordValid] = useState<boolean>(true);

  useEffect(() => nameRef.current?.focus(), []);

  /**
   * Handles changes to the username input field.
   * Updates the name state and resets validation status during typing.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - The change event
   * @param {InputOnChangeData} data - The input change data containing the new value
   */
  const onNameChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setName(data.value);
    setIsNameValid(true); // 不要干扰用户的输入，当失去焦点时才验证
  };

  /**
   * Handles changes to the password input field.
   * Updates the password state and resets validation status during typing.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - The change event
   * @param {InputOnChangeData} data - The input change data containing the new value
   */
  const onPasswordChange = (
    ev: ChangeEvent<HTMLInputElement>,
    data: InputOnChangeData,
  ) => {
    setPassword(data.value);
    setIsPasswordValid(true);
  };

  /**
   * Handles changes to the email input field.
   * Updates the email state and resets validation status during typing.
   * 
   * @param {ChangeEvent<HTMLInputElement>} ev - The change event
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
   * Validates the username input using the isValidUsername utility function.
   * Updates the validation state based on the result.
   * 
   * @param {string} data - The username string to validate
   * @returns {boolean} True if the username is valid, false otherwise
   */
  const validateName = (data: string) => {
    if (isValidUsername(data)) {
      setIsNameValid(true);
      return true;
    }
    setIsNameValid(false);
    return false;
  };

  /**
   * Validates the email input using the isValidEmail utility function.
   * Updates the validation state based on the result.
   * 
   * @param {string} data - The email string to validate
   * @returns {boolean} True if the email is valid, false otherwise
   */
  const validateEmail = (data: string) => {
    if (isValidEmail(data)) {
      setIsEmailValid(true);
      return true;
    }
    setIsEmailValid(false);
    return false;
  };

  /**
   * Validates the password input using the isValidPassword utility function.
   * Updates the validation state based on the result.
   * 
   * @param {string} data - The password string to validate
   * @returns {boolean} True if the password is valid, false otherwise
   */
  const validatePassword = (data: string) => {
    if (isValidPassword(data)) {
      setIsPasswordValid(true);
      return true;
    }
    setIsPasswordValid(false);
    return false;
  };

  /**
   * Validates all form fields (name, email, and password).
   * Uses memoization to optimize performance.
   * 
   * @returns {boolean} True if all fields are valid, false otherwise
   */
  const validate = useCallback(
    () =>
      validateName(name) && validateEmail(email) && validatePassword(password),
    [name, email, password],
  );

  /**
   * Handles successful user registration.
   * Resets form fields, validation states, and saves the user data.
   * 
   * @param {any} user - The user object returned from Supabase authentication
   */
  const onSuccess = (user: any) => {
    setEmail('');
    setPassword('');
    setName('');
    setIsNameValid(true);
    setIsEmailValid(true);
    setIsPasswordValid(true);
    setSuccess(true);
    useAuthStore.getState().saveInactiveUser(user);
  };

  /**
   * Submits the registration form after validation.
   * Creates a new user account through Supabase authentication with email verification.
   * Handles loading states and error notifications.
   */
  const submit = async () => {
    if (validate()) {
      try {
        setLoading(true);
        const protocol = await window.electron.getProtocol();
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${protocol}://login-callback`,
            data: {
              name,
            },
          },
        });
        if (error) {
          notifyError(error.message);
        } else {
          onSuccess(data.user);
        }
      } catch (err) {
        captureException(err as Error);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="page h-full">
      <div className="page-top-bar" />
      <div className="page-header flex items-center justify-between">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl flex-shrink-0 mr-6">
            {t('Account.Action.Create')}
          </h1>
        </div>
      </div>
      <div className="mt-2.5 pb-12 h-full -mr-5 overflow-y-auto">
        <div style={{ maxWidth: '400px' }} className="flex flex-col gap-5">
          <div>
            <Field
              label={
                <InfoLabel
                  info={
                    <ul>
                      <li>{t('Account.Info.NameRule1')}</li>
                      <li>{t('Account.Info.NameRule2')}</li>
                      <li>{t('Account.Info.NameRule3')}</li>
                    </ul>
                  }
                >
                  {t('Account.Name')}
                </InfoLabel>
              }
            >
              <StateInput
                ref={nameRef}
                tabIndex={0}
                {...attributes}
                onBlur={() => validateName(name)}
                value={name}
                className="flex-grow"
                onChange={onNameChange}
                isValid={isNameValid}
                icon={<PersonInfo20Regular />}
                errorMsg={
                  <ul>
                    <li>{t('Account.Info.NameRule1')}</li>
                    <li>{t('Account.Info.NameRule2')}</li>
                    <li>{t('Account.Info.NameRule3')}</li>
                  </ul>
                }
                placeholder={t('Account.Placeholder.UserName')}
              />
            </Field>
          </div>
          <div>
            <Field label={t('Common.Email')}>
              <StateInput
                tabIndex={0}
                {...attributes}
                onBlur={() => validateEmail(email)}
                value={email}
                onChange={onEmailChange}
                type="text"
                icon={<Mail20Regular />}
                isValid={isEmailValid}
                errorMsg={t('Auth.Notification.InvalidEmailWarning')}
              />
            </Field>
          </div>
          <div>
            <Field
              label={
                <InfoLabel info={t('Account.Tooltip.PasswordRule')}>
                  {t('Common.Password')}
                </InfoLabel>
              }
            >
              <MaskableStateInput
                tabIndex={0}
                {...attributes}
                onBlur={() => validatePassword(password)}
                onChange={onPasswordChange}
                value={password}
                isValid={isPasswordValid}
                icon={<Password20Regular />}
                errorMsg={t('Account.Info.PasswordRule')}
              />
            </Field>
          </div>
          <div>
            <StateButton
              appearance="primary"
              onClick={submit}
              loading={loading}
            >
              {t('Account.SignUp')}
            </StateButton>
          </div>
          <div className="tips">
            {t('Account.Info.Agreement')}&nbsp;
            <button
              type="button"
              onClick={() =>
                window.electron.openExternal(
                  'about:blank',
                )
              }
              className="underline"
            >
              {t('Common.TermsOfService')}
            </button>
            &nbsp;{t('Common.And')}&nbsp;
            <button
              type="button"
              onClick={() =>
                window.electron.openExternal('about:blank')
              }
              className="underline"
            >
              {t('Common.PrivacyPolicy')}
            </button>
          </div>
          <div>
            <Link to="/user/login" className="underline">
              {t('Account.Info.AlreadyHaveAnAccountAndToLogin')}
            </Link>
          </div>
        </div>
      </div>
      <AlertDialog
        type="success"
        open={success}
        setOpen={setSuccess}
        title={t('Account.Notification.Created')}
        message={t('Account.Notification.EmailConfirmation')}
        onConfirm={() => navigate('/user/account')}
      />
    </div>
  );
}
