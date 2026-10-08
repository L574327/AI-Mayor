import {
  GetPromptResult,
  ContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import { useTranslation } from 'react-i18next';

/**
 * Props for the MCPPromptContentPreview component
 */
export type MCPPromptContentPreviewProps = {
  /** Array of messages from MCP prompt result to be displayed */
  messages: GetPromptResult['messages'];
};

/**
 * React component that renders MCP prompt content with support for multiple content types.
 * Displays messages in fieldsets with role-based legends and renders content based on type.
 * 
 * @param props - Component props containing messages to render
 * @returns JSX elements representing the rendered prompt content
 */
export default function MCPPromptContentPreview(
  props: MCPPromptContentPreviewProps,
) {
  const { t } = useTranslation();

  /**
   * Renders individual content blocks based on their type.
   * Supports image, audio, text, resource, and resource_link content types.
   * 
   * @param content - The content block to render
   * @returns JSX element representing the rendered content
   */
  const renderContent = (content: ContentBlock) => {
    if (content.type === 'image') {
      return (
        <img
          src={`data:${content.mimeType};base64,${content.data}`}
          alt=""
          className="w-full"
        />
      );
    }

    if (content.type === 'audio') {
      return (
        <audio controls>
          <source
            src={`data:${content.mimeType};base64,${content.data}`}
            type={content.mimeType}
          />
          <track
            kind="captions"
            label={t('Common.NoSubtitlesAvailable')}
            default
          />
          Your browser does not support the audio element.
        </audio>
      );
    }

    if (content.type === 'text') {
      return <pre className="p-0 text-inherit">{content.text || ''}</pre>;
    }

    if (content.type === 'resource') {
      if (content.resource.uri.startsWith('http')) {
        return (
          <a href={content.resource.uri} className="underline cursor-pointer">
            {content.resource.uri}
          </a>
        );
      }
      return <span>{content.resource.uri}</span>;
    }

    if (content.type === 'resource_link') {
      if (content.uri.startsWith('http')) {
        return (
          <a href={content.uri} className="underline cursor-pointer">
            {content.name} {content.title ? `(${content.title})` : ''}
          </a>
        );
      }

      return (
        <span>
          {content.name} {content.title ? `(${content.title})` : ''}
        </span>
      );
    }

    return <span className="tips">${t('Prompt.UnknownContentType')}</span>;
  };

  return props.messages.map((message, index) => {
    const key = `message-${message.role}-${index}-${message.content.type}`;

    return (
      <fieldset
        className="border border-neutral-200 dark:border-neutral-700 rounded p-1 my-2 bg-neutral-50 dark:bg-neutral-800"
        key={key}
      >
        <legend className="text-base font-semibold px-1 ml-2 text-sm">
          {message.role === 'user' ? 'User' : 'Assistant'}&nbsp;
          {message.content.type === 'resource' && (
            <span className="text-sm text-neutral-500">
              ({t('Prompt.Resource')})
            </span>
          )}
          {message.content.type === 'resource_link' && (
            <span className="text-sm text-neutral-500">
              ({t('Prompt.ResourceLink')})
            </span>
          )}
        </legend>
        <div className="p-1 text-xs">{renderContent(message.content)}</div>
      </fieldset>
    );
  });
}
