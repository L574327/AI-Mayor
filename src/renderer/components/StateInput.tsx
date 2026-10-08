import { Button, Input, Tooltip } from '@fluentui/react-components';
import { FluentIcon, Warning20Regular } from '@fluentui/react-icons';
import { forwardRef } from 'react';
import useAppearanceStore from 'stores/useAppearanceStore';

function StateInput(
  props: { isValid: boolean; errorMsg: string; icon: FluentIcon } & any,
  ref: any,
) {
  const getPalette = useAppearanceStore((state) => state.getPalette);
  const { isValid, errorMsg, icon, ...rest } = props;
  return (
    <Input
      {...rest}
      contentBefore={
        isValid ? (
          icon
        ) : (
          <Tooltip content={errorMsg} relationship="label">
            <Button
              tabIndex={-1}
              appearance="subtle"
              icon={<Warning20Regular primaryFill={getPalette('error')} />}
              size="small"
            />
          </Tooltip>
        )
      }
    />
  );
}
export default forwardRef(StateInput);
