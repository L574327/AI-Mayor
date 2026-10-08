import { PositioningShorthand, Tooltip } from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import { ReactNode } from 'react';

export default function TooltipIcon({
  tip,
  positioning = 'above-start',
}: {
  tip: string | undefined | null | ReactNode;
  positioning?: PositioningShorthand;
}) {
  return tip ? (
    <Tooltip
      content={{
        children: tip,
      }}
      positioning={positioning}
      withArrow
      relationship="label"
    >
      <Info16Regular tabIndex={0} className="inline-block ml-1.5" />
    </Tooltip>
  ) : null;
}
