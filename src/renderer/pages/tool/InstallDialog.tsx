import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogTrigger,
  DialogBody,
  Button,
  Field,
  Input,
  DialogActions,
} from '@fluentui/react-components';
import Mousetrap from 'mousetrap';
import { useTranslation } from 'react-i18next';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as mcpUtils from 'utils/mcp';
import { IMCPServer, IMCPServerParameter, MCPArgParameter } from 'types/mcp';
import ListInput from 'renderer/components/ListInput';
import useMCPStore from 'stores/useMCPStore';
import { isNumeric } from 'utils/validators';
import { captureException } from '../../logging';
import { capitalize, omitBy } from 'lodash';
import useMarkdown from 'hooks/useMarkdown';

/**
 * Renders a form section for MCP server parameters (args, env, or headers).
 * Creates input fields based on parameter types and handles validation display.
 * 
 * @param {('args' | 'env' | 'headers')} type - The type of parameters to render
 * @param {IMCPServerParameter[]} params - Array of parameter definitions
 * @param {{ [key: string]: string }} errorMessages - Object containing validation error messages
 * @param {function} setValue - Callback function to update parameter values
 * @returns {JSX.Element | null} The rendered form section or null if no parameters
 */
function Form(
  type: 'args' | 'env' | 'headers',
  params: IMCPServerParameter[],
  errorMessages: { [key: string]: string },
  setValue: (
    type: 'args' | 'env' | 'headers',
    key: string,
    value: string | string[],
  ) => void,
) {
  if (params.length === 0) return null;
  return (
    <div className="mb-4">
      <div className="text-base font-bold mb-1">{capitalize(type)}</div>
      <div className="flex flex-col gap-2">
        {params.map((param: IMCPServerParameter) => {
          return (
            <div key={param.name}>
              {param.type === 'list' ? (
                <Field
                  label={param.name}
                  validationMessage={errorMessages[param.name]}
                  validationState={errorMessages[param.name] ? 'error' : 'none'}
                >
                  <ListInput
                    label={param.name}
                    placeholder={param.description}
                    onChange={(value: string[]) => {
                      setValue(type, param.name, value);
                    }}
                  />
                </Field>
              ) : (
                <Field
                  label={param.name}
                  validationMessage={errorMessages[param.name]}
                  validationState={errorMessages[param.name] ? 'error' : 'none'}
                >
                  <Input
                    className="w-full"
                    placeholder={param.description}
                    onChange={(_, data) => {
                      setValue(type, param.name, data.value);
                    }}
                  />
                </Field>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Dialog component for installing MCP servers with parameter configuration.
 * Allows users to configure server parameters (args, env, headers) before installation.
 * Provides validation, preview, and installation functionality.
 * 
 * @param {Object} options - Component options
 * @param {IMCPServer} options.server - The MCP server configuration to install
 * @param {boolean} options.open - Whether the dialog is open
 * @param {Function} options.setOpen - Function to control dialog open state
 * @returns {JSX.Element} The install dialog component
 */
export default function ToolInstallDialog(options: {
  server: IMCPServer;
  open: boolean;
  setOpen: Function;
}) {
  const { server, open, setOpen } = options;
  const { t } = useTranslation();
  const { render } = useMarkdown();
  const { addServer } = useMCPStore();
  const args = useMemo(() => {
    return server.args ? mcpUtils.getParameters(server.args) : [];
  }, [server.args]);
  const env = useMemo(() => {
    return server.env ? mcpUtils.getParameters(Object.values(server.env)) : [];
  }, [server.env]);
  const headers = useMemo(() => {
    return server.headers
      ? mcpUtils.getParameters(Object.values(server.headers))
      : [];
  }, [server.headers]);
  const hasParams = useMemo(
    () => args.length > 0 || env.length > 0 || headers.length > 0,
    [args, env, headers],
  );
  const [argParams, setArgParams] = useState<{
    [key: string]: string | string[];
  }>({});
  const [envParams, setEnvParams] = useState<{ [key: string]: string }>({});
  const [headerParams, setHeaderParams] = useState<{ [key: string]: string }>(
    {},
  );
  const [errorMessages, setErrorMessages] = useState<{ [key: string]: string }>(
    {},
  );

  const setValue = (
    type: 'args' | 'env' | 'headers',
    key: string,
    value: string | string[],
  ) => {
    if (type === 'args') {
      setArgParams((state) => ({ ...state, [key]: value }));
    } else if (type === 'env') {
      setEnvParams((state) => ({ ...state, [key]: value as string }));
    } else if (type === 'headers') {
      setHeaderParams((state) => ({ ...state, [key]: value as string }));
    } else {
      captureException(`Invalid MCP parameter type:${type}`);
    }
  };

  const isParamValid = useCallback(
    (
      paramDefs: IMCPServerParameter[],
      paramVals: { [key: string]: string | string[] },
    ) => {
      let isAllValid = true;
      paramDefs.forEach((param: IMCPServerParameter) => {
        const paramValue = paramVals[param.name];
        let isValid = true;
        if (param.type === 'number') {
          if (!isNumeric(paramValue as string)) {
            setErrorMessages((state) => ({
              ...state,
              [param.name]: t('Common.Validation.MustBeNumber'),
            }));
            isValid = false;
          }
        } else if (param.type === 'list') {
          if (paramValue?.length === 0) {
            setErrorMessages((state) => ({
              ...state,
              [param.name]: t('Common.Required'),
            }));
            isValid = false;
          }
        } else if (((paramValue as string) || '').trim() === '') {
          setErrorMessages((state) => ({
            ...state,
            [param.name]: t('Common.Required'),
          }));
          isValid = false;
        }
        if (isValid) {
          setErrorMessages((state) => {
            delete state[param.name];
            return state;
          });
        }
        isAllValid = isAllValid && isValid;
      });
      return isAllValid;
    },
    [],
  );

  const previewServer = useMemo(() => {
    const payload = {
      ...server,
    };
    const $argParams = omitBy(
      argParams,
      (value) => !value || value.length === 0,
    );
    if (Object.keys($argParams).length > 0) {
      payload.args = mcpUtils.fillArgs(
        server.args as string[],
        $argParams as MCPArgParameter,
      );
    }
    const $envParams = omitBy(
      envParams,
      (value) => !value || value.length === 0,
    );
    if (Object.keys($envParams).length > 0) {
      payload.env = mcpUtils.FillEnvOrHeaders(server.env, $envParams);
    }
    const $headerParams = omitBy(
      headerParams,
      (value) => !value || value.length === 0,
    );
    if (Object.keys($headerParams).length > 0) {
      payload.headers = mcpUtils.FillEnvOrHeaders(
        server.headers,
        $headerParams,
      );
    }
    return payload;
  }, [server, argParams, envParams, headerParams]);

  const install = async () => {
    if (!server.key) {
      server.key = server.name as string;
    }
    if (server.command) {
      const isArgValid = isParamValid(args, argParams);
      const isEnvValid = isParamValid(env, envParams);
      if (isArgValid && isEnvValid) {
        const payload = {
          ...server,
        };
        if (Object.keys(argParams).length > 0) {
          payload.args = mcpUtils.fillArgs(
            server.args as string[],
            argParams as MCPArgParameter,
          );
        }
        if (Object.keys(envParams).length > 0) {
          payload.env = mcpUtils.FillEnvOrHeaders(server.env, envParams);
        }
        addServer(payload);
        setOpen(false);
      }
    } else {
      const isHeaderValid = isParamValid(headers, headerParams);
      if (isHeaderValid) {
        const payload = {
          ...server,
          headers: mcpUtils.FillEnvOrHeaders(server.headers, headerParams),
        };
        addServer(payload);
        setOpen(false);
      }
    }
  };

  useEffect(() => {
    if (open) {
      Mousetrap.bind('esc', () => setOpen(false));
    }
    return () => {
      Mousetrap.unbind('esc');
      setArgParams({});
      setEnvParams({});
      setErrorMessages({});
    };
  }, [open]);

  return (
    <Dialog open={open}>
      <DialogSurface mountNode={document.body.querySelector('#portal')}>
        <DialogBody>
          <DialogTitle
            action={
              <DialogTrigger action="close">
                <Button
                  onClick={() => setOpen(false)}
                  appearance="subtle"
                  aria-label="close"
                  icon={<Dismiss24Regular />}
                />
              </DialogTrigger>
            }
          >
            {server.name || server.key}
          </DialogTitle>
          <DialogContent>
            <div className="flex flex-col gap-2">
              {hasParams && (
                <div className="flex flex-col gap-2">
                  {Form('args', args, errorMessages, setValue)}
                  {Form('env', env, errorMessages, setValue)}
                  {Form('headers', headers, errorMessages, setValue)}
                </div>
              )}
              <div
                className="text-xs"
                dangerouslySetInnerHTML={{
                  __html: render(
                    `\`\`\`json\n${JSON.stringify(previewServer, null, 2)}\n\`\`\``,
                  )
                }}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle" onClick={() => setOpen(false)}>
                {t('Common.Cancel')}
              </Button>
            </DialogTrigger>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary" onClick={install}>
                {t('Common.Action.Install')}
              </Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
