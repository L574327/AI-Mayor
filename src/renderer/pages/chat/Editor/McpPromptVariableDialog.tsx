import {
  Dialog,
  DialogTrigger,
  Button,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  Field,
  Input,
  DialogActions,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IMCPPromptArgument } from 'types/mcp';

export default function PromptVariableDialog(args: {
  open: boolean;
  variables: IMCPPromptArgument[];
  onCancel: () => void;
  onConfirm: (vars: { [key: string]: string }) => void;
}) {
  const { t } = useTranslation();
  const { open, variables, onCancel, onConfirm } = args;

  const [requiredFileds, setRequiredFileds] = useState<string[]>([]);
  const [values, setValues] = useState<{ [key: string]: string }>({});

  const onValuesChange = (key: string, value: string) => {
    setValues({ ...values, [key]: value });
  };

  const handleConfirm = () => {
    setRequiredFileds([]);

    const requiredVariables = variables.filter((arg) => {
      return arg.required && !values[arg.name]?.trim();
    });

    if (requiredVariables.length > 0) {
      setRequiredFileds(requiredVariables.map((arg) => arg.name));
    } else {
      onConfirm(values);
      setValues({});
      setRequiredFileds([]);
    }
  };

  return (
    <Dialog open={open}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle
            action={
              <DialogTrigger action="close">
                <Button
                  appearance="subtle"
                  aria-label="close"
                  icon={<Dismiss24Regular />}
                  onClick={onCancel}
                />
              </DialogTrigger>
            }
          >
            {t('Prompt.FillVariables')}
          </DialogTitle>
          <DialogContent>
            <div>
              {variables.length ? (
                <div>
                  {variables.map((variable) => {
                    return (
                      <Field
                        label={variable.name}
                        key={`var-${variable.name}`}
                        className="my-2"
                        validationMessage={
                          requiredFileds.includes(variable.name)
                            ? t('Common.Required')
                            : ''
                        }
                        validationState={
                          requiredFileds.includes(variable.name)
                            ? 'error'
                            : undefined
                        }
                      >
                        <Input
                          className="w-full"
                          value={values[variable.name] || ''}
                          placeholder={
                            variable.required
                              ? t('Common.Required')
                              : t('Common.Optional')
                          }
                          onChange={(e) => {
                            onValuesChange(variable.name, e.target.value || '');
                            setRequiredFileds((fileds) =>
                              fileds.filter((f) => f !== variable.name),
                            );
                          }}
                        />
                      </Field>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle" onClick={onCancel}>
                {t('Common.Cancel')}
              </Button>
            </DialogTrigger>
            <Button appearance="primary" onClick={handleConfirm}>
              {t('Common.OK')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
