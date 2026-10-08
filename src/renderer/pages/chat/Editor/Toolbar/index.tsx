import { Button, Toolbar } from '@fluentui/react-components';
import useChatStore from 'stores/useChatStore';
import { IChat, IChatContext } from 'intellichat/types';
import ModelCtrl from './ModelCtrl';
import PromptCtrl from './PromptCtrl';
import TemperatureCtrl from './TemperatureCtrl';
import MaxTokensCtrl from './MaxTokensCtrl';
import ImgCtrl from './ImgCtrl';
import KnowledgeCtrl from './KnowledgeCtrl';
import CtxNumCtrl from './CtxNumCtrl';
import McpPromptCtrl from './McpPromptCtrl';

export default function EditorToolbar({
  ctx,
  isReady,
  onConfirm,
  onTriggerPrompt,
}: {
  ctx: IChatContext;
  isReady: boolean;
  onConfirm: () => void;
  onTriggerPrompt?: (prompt: unknown) => void;
}) {
  const chat = useChatStore((state) => state.chat) as IChat;
  return (
    <div className="py-1.5 bg-brand-surface-1 relative">
      <Toolbar
        aria-label="Default"
        size="small"
        className="flex items-center gap-2 ml-2 editor-toolbar"
      >
        <ModelCtrl ctx={ctx} chat={chat} />
        <div className="flex justify-start items-center gap-2.5 -ml-2">
          <Button
            size="small"
            appearance="subtle"
            onClick={() => void window.electron.aiMayorOverlay.show()}
            title="Open AI Mayor overlay"
          >
            AI Mayor
          </Button>
          <PromptCtrl ctx={ctx} chat={chat} disabled={!isReady} />
          <McpPromptCtrl
            chat={chat}
            disabled={!isReady}
            onTrigger={onTriggerPrompt}
          />
          <KnowledgeCtrl ctx={ctx} chat={chat} disabled={!isReady} />

          <MaxTokensCtrl
            ctx={ctx}
            chat={chat}
            onConfirm={onConfirm}
            disabled={!isReady}
          />
          <div className="-ml-[4px]">
            <TemperatureCtrl ctx={ctx} chat={chat} disabled={!isReady} />
          </div>
          <div className="-ml-[4px]">
            <CtxNumCtrl ctx={ctx} chat={chat} disabled={!isReady} />
          </div>
          <ImgCtrl ctx={ctx} chat={chat} disabled={!isReady} />
        </div>
      </Toolbar>
    </div>
  );
}
