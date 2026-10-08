import type { IReadResult, ITool } from "intellichat/readers/IChatReader";
import {
  calculateDeepSeekCost,
  type DeepSeekApiRequestTelemetry,
  type DeepSeekChatTurnTelemetry,
  summarizeDeepSeekTurn,
} from "intellichat/telemetry/deepseekCost";
import type { IChatContext, IChatMessage, IChatRequestMessage } from "intellichat/types";
import { urlJoin } from "utils/util";
import DeepSeek from "../../providers/DeepSeek";
import type INextChatService from "./INextCharService";
import OpenAIChatService from "./OpenAIChatService";

/**
 * Chat service implementation for DeepSeek AI provider.
 * Extends OpenAIChatService to provide DeepSeek-specific functionality.
 */
export default class DeepSeekChatService extends OpenAIChatService implements INextChatService {
  private telemetryTurn?: DeepSeekChatTurnTelemetry;

  private activeTelemetryRequest?: DeepSeekApiRequestTelemetry;

  /**
   * Creates a new DeepSeekChatService instance.
   * @param name - The name identifier for this chat service
   * @param chatContext - The chat context containing configuration and state
   */
  constructor(name: string, chatContext: IChatContext) {
    super(name, chatContext);
    this.provider = DeepSeek;
  }

  protected makeAssistantContextMessage(message: IChatMessage): IChatRequestMessage {
    const result = super.makeAssistantContextMessage(message);

    if (message.reasoning !== undefined) {
      result.reasoning_content = message.reasoning;
    }

    return result;
  }

  protected async makeToolMessages(
    tool: ITool,
    toolResult: any,
    content?: string,
    reasoning?: string,
  ): Promise<IChatRequestMessage[]> {
    const result = await super.makeToolMessages(tool, toolResult);
    const assistantMessage = result.find((message) => message.role === "assistant" && message.tool_calls);

    if (assistantMessage) {
      if (content !== undefined) {
        assistantMessage.content = content;
      }
      if (reasoning !== undefined) {
        assistantMessage.reasoning_content = reasoning;
      }
    }

    return result;
  }

  /**
   * Formats chat request messages to ensure they are in the expected format for DeepSeek API.
   *
   * @param messages - Array of chat request messages to format
   * @param msgId - Optional message ID for context tracking
   * @returns Promise that resolves to the formatted chat request messages
   */
  protected async makeMessages(messages: IChatRequestMessage[], msgId?: string): Promise<IChatRequestMessage[]> {
    const result = await super.makeMessages(messages, msgId);

    const formated = result
      .map((msg) => {
        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part) => part.text || "").join("\n"),
          };
        }

        return msg;
      })
      .filter(Boolean) as IChatRequestMessage[];

    return formated;
  }

  protected async makePayload(messages: IChatRequestMessage[], msgId?: string) {
    const payload = await super.makePayload(messages, msgId);
    if (payload.stream) {
      payload.stream_options = { include_usage: true };
    }
    return payload;
  }

  protected onApiRequestStart(messages: IChatRequestMessage[]): void {
    const now = new Date();
    if (!this.telemetryTurn) {
      const chatId = this.context.getActiveChat().id;
      this.telemetryTurn = {
        turnId: `${chatId}:${now.getTime()}`,
        chatId,
        startedAt: now.toISOString(),
        requests: [],
      };
    }

    const sequence = this.telemetryTurn.requests.length + 1;
    const request: DeepSeekApiRequestTelemetry = {
      sequence,
      requestId: `${this.telemetryTurn.turnId}:${sequence}`,
      model: this.getModelName(),
      startedAt: now.toISOString(),
      isMcpToolContinuation: messages.some((message) => message.role === "tool"),
      messageCount: messages.length,
    };
    this.telemetryTurn.requests.push(request);
    this.activeTelemetryRequest = request;
  }

  protected onApiRequestComplete(result: IReadResult): void {
    const request = this.activeTelemetryRequest;
    if (!request) return;

    const endedAt = new Date();
    request.requestId = result.requestId || request.requestId;
    request.transportRequestId = this.currentRequestId;
    request.model = result.responseModel || request.model;
    request.endedAt = endedAt.toISOString();
    request.durationMs = endedAt.getTime() - new Date(request.startedAt).getTime();
    request.usage = result.usage;
    if (result.usage) {
      const providerCurrency = this.context.getProvider().currency;
      request.estimatedCost = calculateDeepSeekCost(
        request.model,
        result.usage,
        endedAt,
        providerCurrency === "CNY" ? "CNY" : "USD",
      );
    }

    console.info("[DeepSeek telemetry] API request", request);
    this.traceTool(this.telemetryTurn!.chatId, `DeepSeek API #${request.sequence}`, JSON.stringify(request, null, 2));
    this.activeTelemetryRequest = undefined;
  }

  protected onApiRequestError(error: unknown): void {
    const request = this.activeTelemetryRequest;
    if (!request) return;

    const endedAt = new Date();
    request.transportRequestId = this.currentRequestId;
    request.endedAt = endedAt.toISOString();
    request.durationMs = endedAt.getTime() - new Date(request.startedAt).getTime();
    request.error = error instanceof Error ? error.message : String(error);
    console.info("[DeepSeek telemetry] API request failed", request);
    this.activeTelemetryRequest = undefined;
  }

  protected onChatTurnComplete(error?: unknown): void {
    if (!this.telemetryTurn) return;

    this.telemetryTurn.endedAt = new Date().toISOString();
    const summary = {
      ...summarizeDeepSeekTurn(this.telemetryTurn),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
    console.info("[DeepSeek telemetry] Chat turn summary (estimated cost)", summary);
    this.traceTool(this.telemetryTurn.chatId, "DeepSeek turn telemetry", JSON.stringify(summary, null, 2));
    this.telemetryTurn = undefined;
    this.activeTelemetryRequest = undefined;
  }

  /**
   * Makes an HTTP request to the DeepSeek API for chat completions.
   * Constructs the request URL, headers, and payload specific to DeepSeek's API requirements.
   * @param messages - Array of chat request messages to send
   * @param msgId - Optional message ID for context tracking
   * @returns Promise that resolves to the HTTP response from DeepSeek API
   */
  protected async makeRequest(messages: IChatRequestMessage[], msgId?: string): Promise<Response> {
    const provider = this.context.getProvider();
    const url = urlJoin("/chat/completions", provider.apiBase.trim());
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey.trim()}`,
    };
    const isStream = this.context.isStream();
    const payload = await this.makePayload(messages, msgId);
    return this.makeHttpRequest(url, headers, payload, isStream);
  }
}
