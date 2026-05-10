import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleClient } from "../../src/llm/openai.js";

vi.mock("openai", () => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
  return { default: MockOpenAI };
});

import OpenAI from "openai";
const mockOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;
const mockCreate = vi.mocked(new (mockOpenAI as any)().chat.completions.create);

describe("OpenAICompatibleClient", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("should return text response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Hello!" },
        },
      ],
    } as any);

    const client = new OpenAICompatibleClient("sk-test", "https://api.openai.com/v1", "gpt-4o");
    const result = await client.chat([{ role: "user", content: "hi", timestamp: 0 }], []);

    expect(result.type).toBe("text");
    if (result.type === "text") expect(result.content).toBe("Hello!");
  });

  it("should return tool_call response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "test_tool", arguments: '{"key":"val"}' },
              },
            ],
          },
        },
      ],
    } as any);

    const client = new OpenAICompatibleClient("sk-test", "https://api.openai.com/v1", "gpt-4o");
    const result = await client.chat([{ role: "user", content: "use tool", timestamp: 0 }], []);

    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.toolCall.name).toBe("test_tool");
      expect(result.toolCall.args).toEqual({ key: "val" });
    }
  });
});

import { AnthropicClient } from "../../src/llm/anthropic.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn(() => ({
    messages: { create: mockCreate },
  }));
  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";

const mockAnthropicCreate = vi.mocked(new (Anthropic as unknown as ReturnType<typeof vi.fn>)().messages.create);

describe("AnthropicClient", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
  });

  it("should return text response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello from Claude" }],
    } as any);

    const client = new AnthropicClient("sk-test", "claude-sonnet-4-20250514");
    const result = await client.chat([{ role: "user", content: "hi", timestamp: 0 }], []);

    expect(result.type).toBe("text");
    if (result.type === "text") expect(result.content).toBe("Hello from Claude");
  });

  it("should return tool_call response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "tu_1", name: "test_tool", input: { key: "val" } }],
    } as any);

    const client = new AnthropicClient("sk-test", "claude-sonnet-4-20250514");
    const result = await client.chat([{ role: "user", content: "use tool", timestamp: 0 }], []);

    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.toolCall.name).toBe("test_tool");
      expect(result.toolCall.args).toEqual({ key: "val" });
    }
  });
});
