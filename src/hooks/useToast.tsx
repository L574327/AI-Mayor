import {
  useId,
  useToastController,
  Toast,
  ToastTitle,
  ToastBody,
  ToastIntent,
} from '@fluentui/react-components';

import {
  Dismiss16Regular,
  Dismiss16Filled,
  bundleIcon,
} from '@fluentui/react-icons';

const DismissIcon = bundleIcon(Dismiss16Filled, Dismiss16Regular);

export default function useToast() {
  const { dispatchToast, dismissToast } = useToastController('toaster');
  const toastId = useId('app');
  const $notify = ({
    title,
    message,
    intent,
  }: {
    title: string;
    message: string;
    intent: ToastIntent;
  }) => {
    dispatchToast(
      <Toast>
        <ToastTitle>
          <div className="flex justify-between items-center w-full">
            <strong>{title}</strong>
            <DismissIcon onClick={dismiss} />
          </div>
        </ToastTitle>
        <ToastBody>
          <div style={{ width: '95%' }} className="toast-content">
            {message}
          </div>
        </ToastBody>
      </Toast>,
      { toastId, intent, pauseOnHover: true, position: 'top-end' },
    );
  };
  const dismiss = () => dismissToast(toastId);

  const notifyError = (message: string) =>
    $notify({ title: 'Error', message, intent: 'error' });
  const notifyWarning = (message: string) =>
    $notify({ title: 'Warning', message, intent: 'warning' });
  const notifyInfo = (message: string) =>
    $notify({ title: 'Info', message, intent: 'info' });
  const notifySuccess = (message: string) =>
    $notify({ title: 'Success', message, intent: 'success' });
  return { notifyError, notifyWarning, notifyInfo, notifySuccess };
}
