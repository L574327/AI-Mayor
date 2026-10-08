import { describe, expect, test } from "@jest/globals";
import OpenAIReader from "../../src/intellichat/readers/OpenAIReader";

class MockReader {
  private cursor = 0;

  private readonly chunks: Array<{ value: Uint8Array; done: boolean }>;

  constructor(stream: string) {
    const encoder = new TextEncoder();
    const lines = stream.split("\n");
    this.chunks = lines.map((line, index) => ({
      value: encoder.encode(line),
      done: index === lines.length - 1,
    }));
  }

  async read() {
    return this.chunks[this.cursor++];
  }
}

describe("DeepSeek streaming usage", () => {
  test("keeps request metadata and the final detailed usage chunk", async () => {
    const stream = [
      'data: {"id":"request-1","model":"deepseek-v4-pro","choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
      'data: {"id":"request-1","model":"deepseek-v4-pro","choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
      'data: {"id":"request-1","model":"deepseek-v4-pro","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":40,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":20},"total_tokens":150}}',
      "data: [DONE]",
    ].join("\n");
    const reader = new OpenAIReader(new MockReader(stream) as unknown as ReadableStreamDefaultReader<Uint8Array>);

    const result = await reader.read({
      onProgress: () => {},
      onError: (error) => {
        throw error;
      },
      onToolCalls: () => {},
    });

    expect(result).toMatchObject({
      content: "done",
      reasoning: "think",
      requestId: "request-1",
      responseModel: "deepseek-v4-pro",
      inputTokens: 120,
      outputTokens: 30,
      usage: {
        promptTokens: 120,
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 40,
        completionTokens: 30,
        reasoningTokens: 20,
        totalTokens: 150,
      },
    });
  });
});
